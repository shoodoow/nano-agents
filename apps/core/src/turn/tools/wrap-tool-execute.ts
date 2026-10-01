import { randomUUID } from "node:crypto";
import type { AgentMode } from "../types.js";
import { DISPATCHER_TOOL_BUDGET_MS } from "../constants.js";
import { tracePreview } from "../trace/sinks/jsonl.js";
import type { ToolContext } from "./context.js";

export function wrapToolExecute(
  ctx: ToolContext,
  mode: AgentMode,
  name: string,
  execute: (input: Record<string, unknown>) => Promise<unknown>,
) {
  return async (input: Record<string, unknown>) => {
    const toolCallId = randomUUID();
    const started = performance.now();
    await ctx.traceSession?.emit({ type: "tool.call.start", toolCallId, name, input });
    try {
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
