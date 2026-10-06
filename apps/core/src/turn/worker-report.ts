/** Normalizes worker final text so the parent always gets a readable report. DB: written to delegations.result. */
const MAX = 20_000;

/** Posted today when generateText's final step has no text. Never show this to the person. */
export const EMPTY_WORKER_REPORT = "The worker finished with no output.";

type ToolLike = { toolName?: string; output?: unknown; result?: unknown };
type StepLike = { text?: string; reasoningText?: string; toolResults?: ToolLike[]; toolCalls?: unknown[] };

export type WorkerModelResult = {
  text?: string;
  reasoningText?: string;
  steps?: StepLike[];
  toolResults?: ToolLike[];
};

export function isEmptyWorkerReport(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length === 0 ||
    trimmed === EMPTY_WORKER_REPORT ||
    trimmed.startsWith("Findings: (no output)")
  );
}

/** Labeled report sections (prompt convention — not a hard pass/fail gate). */
const REPORT_MARKERS = /(^|\n)\s*(\*{0,2}(findings|what i did|blockers)\*{0,2}\s*:)|NEEDS_PERSON:/i;

/** Mid-task narration that promises a next step the worker never took. */
export const NEXT_STEP_NARRATION = /\b(let me|i'?ll|i will|going to|about to|now i'?ll|let's)\b/i;

/** Screens only the person can clear (login/2FA/payment), seen but not acted on. */
const PERSON_GATE = /\b(log in|login|sign in|sign-in|signin|logged out|log back in|2fa|two-?factor|verification code|verify (?:your|it'?s you)|enter (?:your )?password|password|checkpoint|confirm it'?s you|payment)\b/i;

const WRITTEN_PATH = /(?:\/shared|\/home|\/var\/nano)\/[A-Za-z0-9_./-]+/g;

/**
 * Paths a finished report claims it wrote.
 * Why: a worker can say the engine finished when the file was never created.
 * Input: report text. Output: absolute paths mentioned as written output.
 */
export function claimedWrittenPaths(text: string): string[] {
  const paths = new Set<string>();
  for (const line of text.split("\n")) {
    if (/\b(missing|not found|does not exist|doesn't exist|absent|never written)\b/i.test(line)) continue;
    if (!/\b(wrote|written|saved|created|output file|file at)\b/i.test(line)) continue;
    for (const match of line.match(WRITTEN_PATH) ?? []) {
      paths.add(match.replace(/[.,;:]+$/, ""));
    }
  }
  return [...paths];
}

export type WorkerEnding =
  | { kind: "report"; result: string }
  | { kind: "needs_person"; result: string }
  | { kind: "stall" };

/**
 * Decides whether a worker ending is deliverable.
 * Why: the AI SDK stops on a text-only step, so "Let me…" with no tools used to
 * ship as a fake success. Tool work is trusted — narration after tools is
 * progress, not failure. Findings labels stay a prompt convention only.
 */
export function classifyWorkerEnding(text: string, ranTools: boolean): WorkerEnding {
  const trimmed = text.trim();

  if (/NEEDS_PERSON:/i.test(trimmed)) {
    return { kind: "report", result: trimmed.slice(0, MAX) };
  }

  // No tools: empty or next-step narration never acted. Login walls become a handoff.
  if (!ranTools) {
    if (!trimmed || NEXT_STEP_NARRATION.test(trimmed)) {
      if (trimmed && PERSON_GATE.test(trimmed)) {
        return { kind: "needs_person", result: "NEEDS_PERSON: Sign in on my computer, then tell me to continue." };
      }
      return { kind: "stall" };
    }
    return { kind: "report", result: trimmed.slice(0, MAX) };
  }

  // Tools ran: always deliver. Empty body is filled by resolveWorkerEnding.
  if (trimmed && PERSON_GATE.test(trimmed) && NEXT_STEP_NARRATION.test(trimmed) && !REPORT_MARKERS.test(trimmed)) {
    // Stuck on a login/2FA wall after looking — ask the person, don't retry-loop.
    return { kind: "needs_person", result: "NEEDS_PERSON: Sign in on my computer, then tell me to continue." };
  }
  return { kind: "report", result: trimmed.slice(0, MAX) };
}

/**
 * Pulls a deliverable report out of a generateText result.
 * Prefers a labeled Findings block from any step over the last mid-task line.
 */
export function collectWorkerText(result: WorkerModelResult): string {
  const steps = result.steps ?? [];
  const texts = [...steps.map((step) => step.text ?? ""), result.text ?? ""].map((part) => part.trim()).filter(Boolean);
  for (let i = texts.length - 1; i >= 0; i--) {
    const report = findingsSlice(texts[i]!);
    if (report) return report.slice(0, MAX);
  }
  const lastText = texts.at(-1);
  if (lastText) return lastText.slice(0, MAX);
  const reasoning = [...steps.map((step) => step.reasoningText ?? ""), result.reasoningText ?? ""]
    .map((part) => part.trim())
    .filter(Boolean);
  for (let i = reasoning.length - 1; i >= 0; i--) {
    const report = findingsSlice(reasoning[i]!);
    if (report) return report.slice(0, MAX);
  }
  return "";
}

/** Short tool digest for the parent when the model never wrote a report. */
export function collectWorkerFallback(result: WorkerModelResult): string {
  const steps = result.steps ?? [];
  const tools = [...(result.toolResults ?? []), ...steps.flatMap((step) => step.toolResults ?? [])];
  const lines = tools
    .map((tool) => {
      const body = stringifyOutput(tool.output ?? tool.result).trim();
      if (!body) return "";
      return `${tool.toolName ?? "tool"}: ${body.slice(0, 400)}`;
    })
    .filter(Boolean)
    .slice(-5);
  if (lines.length === 0) return "";
  return `The model ran tools but wrote no report.\n${lines.join("\n")}`.slice(0, MAX);
}

export function workerRanTools(result: WorkerModelResult): boolean {
  if ((result.toolResults?.length ?? 0) > 0) return true;
  return (result.steps ?? []).some(
    (step) => (step.toolCalls?.length ?? 0) > 0 || (step.toolResults?.length ?? 0) > 0,
  );
}

/**
 * Single policy for turning a generateText result into a worker ending.
 * Tools + empty text → done with tool digest. Stall only when nothing ran.
 */
export function resolveWorkerEnding(result: WorkerModelResult): WorkerEnding {
  const ranTools = workerRanTools(result);
  const text = collectWorkerText(result);
  const ending = classifyWorkerEnding(text, ranTools);
  if (ending.kind !== "report") return ending;
  if (ending.result.trim()) return ending;
  const fallback = collectWorkerFallback(result);
  if (fallback) return { kind: "report", result: fallback };
  if (ranTools) {
    return { kind: "report", result: "Tools ran but produced no text output." };
  }
  return { kind: "stall" };
}

export function formatWorkerReport(raw: string, status: "done" | "failed"): string {
  const trimmed = raw.trim();
  if (trimmed.length > 0) return trimmed.slice(0, MAX);
  if (status === "failed") {
    return "Findings: Worker failed.\nWhat I did: The run ended with an error and no details.\nBlockers: unknown";
  }
  return "Findings: (no output)\nWhat I did: Task completed but the model returned no text.\nBlockers: none";
}

function findingsSlice(text: string): string | null {
  const needs = text.match(/NEEDS_PERSON:\s*.+/i);
  if (needs) return needs[0].trim();
  const at = text.search(/Findings:/i);
  if (at < 0) return null;
  return text.slice(at).trim();
}

function stringifyOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object" && "value" in output) {
    return stringifyOutput((output as { value: unknown }).value);
  }
  try {
    return JSON.stringify(omitHeavyMedia(output));
  } catch {
    return "";
  }
}

/** Drop base64 / huge blobs so parent fallback never re-bills screenshot pixels. */
function omitHeavyMedia(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitHeavyMedia);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "pngBase64" || key === "base64") {
      out[key] = "[omitted — use path]";
      continue;
    }
    if (typeof child === "string" && child.length > 4_000 && /^[A-Za-z0-9+/=\s]+$/.test(child.slice(0, 80))) {
      out[key] = "[omitted — use path]";
      continue;
    }
    out[key] = omitHeavyMedia(child);
  }
  return out;
}
