/** Normalizes worker final text so the parent always gets a readable report. DB: written to delegations.result. */
const MAX = 20_000;

/** Posted today when generateText's final step has no text. Never show this to the person. */
export const EMPTY_WORKER_REPORT = "The worker finished with no output.";

type ToolLike = { toolName?: string; output?: unknown; result?: unknown };
type StepLike = { text?: string; reasoningText?: string; toolResults?: ToolLike[] };

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

/**
 * Pulls a deliverable report out of a generateText result.
 * Why: AI SDK `text` is only the final step. OpenRouter reasoning models
 * (Deepseek and others) often end on a tool step or put Findings in reasoning,
 * so `text` is empty even though the run produced a report.
 */
export function collectWorkerText(result: WorkerModelResult): string {
  const steps = result.steps ?? [];
  const texts = [...steps.map((step) => step.text ?? ""), result.text ?? ""].map((part) => part.trim()).filter(Boolean);
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
    return JSON.stringify(output);
  } catch {
    return "";
  }
}
