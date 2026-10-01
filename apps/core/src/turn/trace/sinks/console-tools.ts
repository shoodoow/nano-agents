/**
 * Dev sink: log model prompt, message history, and tool calls to stdout.
 * DB: none. Must not throw (turn trace fanout uses allSettled).
 */
import type { TracePlugin } from "../plugins.js";
import type { TraceContext, TraceEvent } from "../types.js";

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const consoleToolCallTracePlugin: TracePlugin = {
  name: "console-tools",
  onEvent(ctx: TraceContext, event: TraceEvent) {
    const tag = `[tool-trace ${ctx.mode} run=${ctx.runId.slice(0, 8)}]`;
    // if (event.type === "run.start") {
    //   console.log(
    //     `${tag} run.start cacheKey=${event.promptCacheKey} tools=${event.toolNames.join(",")}`,
    //   );
    //   console.log(`${tag} prefix:\n${event.prefix}`);
    //   console.log(`${tag} tail:\n${event.tail}`);
    //   console.log(`${tag} instructions:\n${safeJson(event.instructions)}`);
    //   console.log(`${tag} modelMessages:\n${safeJson(event.modelMessages)}`);
    //   return;
    // }
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
