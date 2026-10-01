/** Normalizes worker final text so parent always gets a readable report. DB: written to delegations.result. */
const MAX = 20_000;

export function formatWorkerReport(raw: string, status: "done" | "failed"): string {
  const trimmed = raw.trim();
  if (trimmed.length > 0) return trimmed.slice(0, MAX);
  if (status === "failed") {
    return "Findings: Worker failed.\nWhat I did: The run ended with an error and no details.\nBlockers: unknown";
  }
  return "Findings: (no output)\nWhat I did: Task completed but the model returned no text.\nBlockers: none";
}
