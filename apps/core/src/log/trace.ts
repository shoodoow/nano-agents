import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ToolTraceStep = {
  time: string;
  accountId: string;
  conversationId: string;
  agentId: string;
  runId: string;
  step: number;
  text: string;
  tools: { name: string; input: unknown; output: string }[];
};

export type ToolTracePrompt = {
  time: string;
  accountId: string;
  conversationId: string;
  agentId: string;
  runId: string;
  kind: "prompt";
  prefix: string;
  tail: string;
  promptCacheKey: string;
};

export type ToolTraceError = {
  time: string;
  accountId: string;
  conversationId: string;
  agentId: string;
  runId: string;
  kind: "generate-error";
  message: string;
};

/**
 * Returns the JSONL trace file path.
 * Why: single choke point so the location never drifts between writers.
 * Input: none. Output: absolute path under apps/core.
 */
function tracePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", ".tool-trace.log");
}

/**
 * Appends one tool-step line for a model step (never throws).
 * Why: turns previously logged nothing about tool use — a silent model and a
 * failing tool looked identical. One JSONL line per step names each tool call,
 * its truncated input, and its truncated output/error, so debugging reads the
 * file instead of guessing.
 * Input: the step record. Output: nothing. Best-effort: logging never fails a turn.
 */
export async function traceStep(step: Omit<ToolTraceStep, "time">): Promise<void> {
  try {
    await mkdir(dirname(tracePath()), { recursive: true });
    await appendFile(tracePath(), JSON.stringify({ time: new Date().toISOString(), ...step }) + "\n", "utf8");
  } catch {
    // Logging is best-effort; a full disk must not fail the turn.
  }
}

/**
 * Appends one model-failure line with the real exception (never throws).
 * Why: speakOnce folds every exception into one generic bubble, so the phone
 * never shows whether the key, the model id, or the network failed. The trace
 * keeps the real message (truncated, never secrets) next to the run id.
 * Input: the error record. Output: nothing. Best-effort like traceStep.
 */
export async function traceError(error: Omit<ToolTraceError, "time">): Promise<void> {
  try {
    await mkdir(dirname(tracePath()), { recursive: true });
    await appendFile(tracePath(), JSON.stringify({ time: new Date().toISOString(), ...error }) + "\n", "utf8");
  } catch {
    // See traceStep.
  }
}

/**
 * Appends the full prompt one speaker sees (never throws).
 * Why: debugging "why didn't it know X" needs the exact prefix + tail, not a
 * reconstruction. Logged once per speaker turn, before the model runs. Full
 * text on purpose — tails are bounded by the slice budget, prefixes by tools.
 * Input: ids plus prefix/tail/cache key. Output: nothing. Best-effort.
 */
export async function tracePrompt(prompt: Omit<ToolTracePrompt, "time">): Promise<void> {
  try {
    await mkdir(dirname(tracePath()), { recursive: true });
    await appendFile(tracePath(), JSON.stringify({ time: new Date().toISOString(), ...prompt }) + "\n", "utf8");
  } catch {
    // See traceStep.
  }
}

/**
 * Truncates arbitrary tool output to a trace-safe string.
 * Why: tool results can be megabytes (page markdown); the trace keeps the
 * head that explains behavior, not the payload.
 * Input: unknown output. Output: <=500-char string.
 */
export function tracePreview(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
  return text.length > 500 ? text.slice(0, 500) + "…[truncated]" : text;
}
