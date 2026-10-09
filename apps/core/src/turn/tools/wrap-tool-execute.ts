import { randomUUID } from "node:crypto";
import type { AgentMode } from "../types.js";
import { dispatcherToolBudgetError, dispatcherToolBudgetMs } from "./dispatcher-tool-budget.js";
import { tracePreview } from "../trace/sinks/jsonl.js";
import { reviewToolCall } from "../auto-review.js";
import type { ToolContext } from "./context.js";
import { prompt } from "../../prompt/prompts.js";
import { workEntry } from "../work-log.js";

/** Same tool + byte-identical input this many times in a row = a loop, not work. */
export const DOOM_LOOP_THRESHOLD = 3;

/** Text: prompts/dispatcher.md. */
export const doomLoopError = (): string => prompt("dispatcher", "doom-loop");

/** Tools that start background work; once one succeeds the dispatcher's turn is over. */
const HANDOFF_TOOLS = new Set(["spawn_worker", "redirect_worker", "delegate"]);

/** Calls whose result cannot change within one turn; a repeat is answered from the transcript. */
const REPEATABLE_READS = new Set(["read", "read_skill", "web_fetch", "glob", "grep"]);

/** Text: prompts/dispatcher.md. */
const alreadyLoaded = (): string => prompt("dispatcher", "already-loaded");

/** What a read-type call looked at, as one short line for a later worker brief. */
function lookedAt(name: string, input: Record<string, unknown>): string | null {
  if (name === "read" && typeof input.path === "string") return input.path;
  if (name === "web_fetch" && typeof input.url === "string") return input.url;
  if (name === "read_skill" && typeof input.name === "string") return `skill ${input.name}`;
  return null;
}

function isToolError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}

export function wrapToolExecute(
  ctx: ToolContext,
  mode: AgentMode,
  name: string,
  execute: (input: Record<string, unknown>) => Promise<unknown>,
) {
  return async (input: Record<string, unknown>) => {
    const toolCallId = randomUUID();
    const started = performance.now();
    const inputJson = JSON.stringify(input ?? {});
    const recent = (ctx.recentCalls ??= []);
    recent.push({ name, input: inputJson });
    if (recent.length > DOOM_LOOP_THRESHOLD) recent.shift();
    if (
      recent.length === DOOM_LOOP_THRESHOLD &&
      recent.every((call) => call.name === name && call.input === inputJson)
    ) {
      const durationMs = Math.round(performance.now() - started);
      await ctx.traceSession?.emit({
        type: "tool.call.finish",
        toolCallId,
        name,
        input,
        outputPreview: tracePreview(doomLoopError()),
        durationMs,
        error: "doom_loop",
      });
      return { error: doomLoopError() };
    }
    // A read that already succeeded this turn is still in the transcript above;
    // loading it again only resends the same text on every later step.
    const loadKey = `${name}:${inputJson}`;
    if (REPEATABLE_READS.has(name) && ctx.loaded?.has(loadKey)) {
      await ctx.traceSession?.emit({
        type: "tool.call.finish",
        toolCallId,
        name,
        input,
        outputPreview: tracePreview(alreadyLoaded()),
        durationMs: 0,
        error: "already_loaded",
      });
      return alreadyLoaded();
    }
    await ctx.traceSession?.emit({ type: "tool.call.start", toolCallId, name, input });
    try {
      const reviewed = await reviewToolCall(ctx, name, input ?? {});
      if (!reviewed.allow) {
        const durationMs = Math.round(performance.now() - started);
        await ctx.traceSession?.emit({
          type: "tool.call.finish",
          toolCallId,
          name,
          input,
          outputPreview: tracePreview(reviewed.reason),
          durationMs,
          error: "auto_review",
        });
        return {
          blocked: true,
          approvalId: reviewed.approvalId,
          error: reviewed.reason,
        };
      }
      let result: unknown;
      const budgetMs =
        mode === "dispatcher" || mode === "delegate" ? dispatcherToolBudgetMs(name) : null;
      if (budgetMs != null) {
        result = await Promise.race([
          execute(input),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(dispatcherToolBudgetError(budgetMs))), budgetMs),
          ),
        ]);
      } else {
        result = await execute(input);
      }
      if (HANDOFF_TOOLS.has(name) && !isToolError(result)) ctx.handedOff = true;
      const failedResult = isToolError(result);
      if (REPEATABLE_READS.has(name) && !failedResult) (ctx.loaded ??= new Set()).add(loadKey);
      (ctx.workEntries ??= []).push(workEntry(name, input ?? {}, result, failedResult));
      const looked = lookedAt(name, input ?? {});
      if (looked) (ctx.touched ??= new Set()).add(looked);
      const durationMs = Math.round(performance.now() - started);
      await ctx.traceSession?.emit({
        type: "tool.call.finish",
        toolCallId,
        name,
        input,
        outputPreview: tracePreview(result),
        durationMs,
      });
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      const message = error instanceof Error ? error.message : "Tool failed.";
      (ctx.workEntries ??= []).push(workEntry(name, input ?? {}, message, true));
      await ctx.traceSession?.emit({
        type: "tool.call.finish",
        toolCallId,
        name,
        input,
        outputPreview: tracePreview(message),
        durationMs,
        error: message,
      });
      throw error;
    }
  };
}

