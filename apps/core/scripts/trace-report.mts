/**
 * Summarizes the tool trace log per run: steps, tokens, failed and repeated tool calls.
 * Why: "it burns tokens" is only fixable when each run's cost and waste are
 * visible. Run before and after a prompt or loop change and compare.
 *
 * Usage (from apps/core):
 *   npx tsx scripts/trace-report.mts                      # every conversation in the log
 *   npx tsx scripts/trace-report.mts <conversationId>     # one conversation
 *   npx tsx scripts/trace-report.mts <conversationId> 2026-10-09T12:00   # only runs after a time
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type Usage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
type Run = {
  runId: string;
  mode: string;
  started: string;
  steps: number;
  input: number;
  cached: number;
  output: number;
  firstStepInput: number;
  calls: number;
  failed: number;
  repeats: number;
  seen: Map<string, number>;
  tools: Map<string, number>;
};

const [conversationId, since] = process.argv.slice(2);
const logPath = fileURLToPath(new URL("../.tool-trace.log", import.meta.url));
const runs = new Map<string, Run>();

const looksFailed = (record: { error?: unknown; output?: unknown }): boolean => {
  if (record.error) return true;
  const output = typeof record.output === "string" ? record.output : JSON.stringify(record.output ?? "");
  return /^\{"error"|^Path is outside|^Skill not found|^cat: /.test(output);
};

for await (const line of createInterface({ input: createReadStream(logPath) })) {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    continue;
  }
  if (conversationId && record.conversationId !== conversationId) continue;
  if (since && String(record.time) < since) continue;
  const key = `${String(record.runId)}:${String(record.mode)}`;
  const run =
    runs.get(key) ??
    ({
      runId: String(record.runId),
      mode: String(record.mode),
      started: String(record.time),
      steps: 0,
      input: 0,
      cached: 0,
      output: 0,
      firstStepInput: 0,
      calls: 0,
      failed: 0,
      repeats: 0,
      seen: new Map(),
      tools: new Map(),
    } satisfies Run);
  runs.set(key, run);
  if (record.kind === "tool") {
    run.calls += 1;
    const name = String(record.name);
    run.tools.set(name, (run.tools.get(name) ?? 0) + 1);
    if (looksFailed(record)) run.failed += 1;
    const signature = `${name}:${JSON.stringify(record.input)}`;
    const count = (run.seen.get(signature) ?? 0) + 1;
    run.seen.set(signature, count);
    if (count > 1) run.repeats += 1;
  } else if (typeof record.step === "number") {
    const usage = (record.usage ?? {}) as Usage;
    run.steps += 1;
    run.input += usage.inputTokens ?? 0;
    run.cached += usage.cacheReadTokens ?? 0;
    run.output += usage.outputTokens ?? 0;
    if (record.step === 1 && run.firstStepInput === 0) run.firstStepInput = usage.inputTokens ?? 0;
  }
}

const rows = [...runs.values()].filter((run) => run.steps > 0).sort((a, b) => a.started.localeCompare(b.started));
const pad = (value: string | number, width: number) => String(value).padStart(width);
console.log(
  `${"time".padEnd(19)} ${"mode".padEnd(10)} ${"run".padEnd(8)} ${pad("steps", 5)} ${pad("input", 9)} ${pad("cached", 9)} ${pad("output", 7)} ${pad("step1", 7)} ${pad("calls", 5)} ${pad("fail", 4)} ${pad("rep", 3)}  tools`,
);
const total = { dispatcher: { steps: 0, input: 0, cached: 0, output: 0, calls: 0, failed: 0, repeats: 0 }, worker: { steps: 0, input: 0, cached: 0, output: 0, calls: 0, failed: 0, repeats: 0 } };
for (const run of rows) {
  const tools = [...run.tools.entries()].map(([name, count]) => (count > 1 ? `${name}x${count}` : name)).join(" ");
  console.log(
    `${run.started.slice(0, 19)} ${run.mode.padEnd(10)} ${run.runId.slice(0, 8)} ${pad(run.steps, 5)} ${pad(run.input, 9)} ${pad(run.cached, 9)} ${pad(run.output, 7)} ${pad(run.firstStepInput, 7)} ${pad(run.calls, 5)} ${pad(run.failed, 4)} ${pad(run.repeats, 3)}  ${tools}`,
  );
  const bucket = run.mode === "worker" ? total.worker : total.dispatcher;
  bucket.steps += run.steps;
  bucket.input += run.input;
  bucket.cached += run.cached;
  bucket.output += run.output;
  bucket.calls += run.calls;
  bucket.failed += run.failed;
  bucket.repeats += run.repeats;
}
for (const [name, bucket] of Object.entries(total)) {
  const failRate = bucket.calls > 0 ? `${Math.round((bucket.failed / bucket.calls) * 100)}%` : "-";
  console.log(
    `TOTAL ${name.padEnd(10)} steps=${bucket.steps} input=${bucket.input} cached=${bucket.cached} output=${bucket.output} calls=${bucket.calls} failed=${bucket.failed} (${failRate}) repeated=${bucket.repeats}`,
  );
}
console.log("step1 = input tokens of the run's first step: the fixed cost of prompt + tool schemas + history.");
