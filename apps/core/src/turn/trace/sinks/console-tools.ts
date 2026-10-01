/**
 * Dev sink: log every tool call input and result to stdout.
 * DB: none. Must not throw (turn trace fanout uses allSettled).
 */
import type { TracePlugin } from "../plugins.js";
import type { TraceContext, TraceEvent } from "../types.js";

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const consoleToolCallTracePlugin: TracePlugin = {
  name: "console-tools",
  onEvent(ctx: TraceContext, event: TraceEvent) {
    const tag = `[tool-trace ${ctx.mode} run=${ctx.runId.slice(0, 8)}]`;
    if (event.type === "tool.call.start") {
      console.log(`${tag} call ${event.name} id=${event.toolCallId} input=${safeJson(event.input)}`);
      return;
    }
    if (event.type === "tool.call.finish") {
      const err = event.error ? ` error=${event.error}` : "";
      console.log(
        `${tag} done ${event.name} id=${event.toolCallId} ${event.durationMs}ms${err} result=${event.outputPreview}`,
      );
    }
  },
};
