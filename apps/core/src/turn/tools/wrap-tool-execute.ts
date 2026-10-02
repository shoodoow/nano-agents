import { randomUUID } from "node:crypto";
import type { AgentMode } from "../types.js";
import { DISPATCHER_TOOL_BUDGET_MS } from "../constants.js";
import { tracePreview } from "../trace/sinks/jsonl.js";
import { reviewToolCall } from "../auto-review.js";
import type { ToolContext } from "./context.js";

/** Same tool + byte-identical input this many times in a row = a loop, not work. */
export const DOOM_LOOP_THRESHOLD = 3;

export const DOOM_LOOP_ERROR =
  "Same call 3 times in a row — stop looping. send_message a short status and end the turn now. Finished worker results arrive on their own; failed ones re-wake you.";

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
        outputPreview: tracePreview(DOOM_LOOP_ERROR),
        durationMs,
        error: "doom_loop",
      });
      return { error: DOOM_LOOP_ERROR };
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
      if (mode === "dispatcher" || mode === "delegate") {
        result = await Promise.race([
          execute(input),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Tool exceeded 2s — use spawn_worker for long work.")),
              DISPATCHER_TOOL_BUDGET_MS,
            ),
          ),
        ]);
      } else {
        result = await execute(input);
      }
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

