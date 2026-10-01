/**
 * Default trace sink: append JSONL to apps/core/.tool-trace.log (legacy path).
 * DB: none. Why: dev harness / DeepSeek-style inspect until UI plugin ships.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tracePreview } from "../../../log/trace.js";
import type { TracePlugin } from "../plugins.js";
import type { TraceContext, TraceEvent } from "../types.js";

function tracePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "..", ".tool-trace.log");
}

async function appendLine(record: Record<string, unknown>): Promise<void> {
  try {
    const path = tracePath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify({ time: new Date().toISOString(), ...record }) + "\n", "utf8");
  } catch {
    // Best-effort.
  }
}

export const jsonlTracePlugin: TracePlugin = {
  name: "jsonl",
  async onEvent(ctx: TraceContext, event: TraceEvent) {
    const base = {
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      runId: ctx.runId,
      mode: ctx.mode,
      traceId: ctx.traceId,
    };
    if (event.type === "run.start") {
      await appendLine({
        ...base,
        kind: "prompt",
        prefix: event.prefix,
        tail: event.tail,
        promptCacheKey: event.promptCacheKey,
        tools: event.toolNames,
      });
    } else if (event.type === "model.step.finish") {
      await appendLine({
        ...base,
        step: event.step,
        text: event.text.slice(0, 300),
        usage: event.usage,
        tools: event.toolCalls.map((call, index) => ({
          name: call.name,
          input: call.input,
          output: event.toolResults[index]?.outputPreview ?? "(no result yet)",
        })),
      });
    } else if (event.type === "tool.call.finish") {
      await appendLine({
        ...base,
        kind: "tool",
        name: event.name,
        durationMs: event.durationMs,
        input: event.input,
        output: event.outputPreview,
        error: event.error,
      });
    } else if (event.type === "run.finish") {
      await appendLine({ ...base, kind: "run.finish", text: event.text.slice(0, 300), usage: event.usage, steps: event.steps });
    } else if (event.type === "run.error") {
      await appendLine({ ...base, kind: "generate-error", phase: event.phase, message: event.message.slice(0, 500) });
    }
  },
};

export { tracePreview };
