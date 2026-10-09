import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Built-in worker kinds (specialists). `custom` uses parent-supplied instructions. */
export const WORKER_KINDS = [
  "executor",
  "computer",
  "browser",
  "explore",
  "shell",
  "debug",
  "watch_video",
  "video_review",
  "vm_setup",
  "docs",
  "custom",
] as const;

export type WorkerKind = (typeof WORKER_KINDS)[number];

export const WORKER_KIND_HINTS: Record<Exclude<WorkerKind, "custom">, string> = {
  executor: "General background work: search, fetch, files, light shell. Default when unsure.",
  computer: "Desktop GUI apps / login-gated screen: read_skill computer-use-linux (text-first; screenshots rare).",
  browser: "Public web via web_search/web_fetch first; chrome-devtools for live pages; desktop only if needed.",
  explore: "Find files and code: glob, grep, read. No desktop unless the task demands it.",
  shell: "Commands, installs, scripts, long-running processes on the Linux box.",
  debug: "Hypothesis-driven debugging with evidence from logs, files, and commands.",
  watch_video: "Describe or answer questions about a video/media file on the box.",
  video_review: "Review a generated or recorded video against expected behavior.",
  vm_setup: "Discover how to set up a project: deps, scripts, config, run instructions.",
  docs: "Read public docs via search/fetch and return accurate product/API guidance.",
};

const META_KIND = /^WORKER_KIND=([a-z_]+)\n/;
const CUSTOM_BLOCK = /^WORKER_KIND=custom\n<<<CUSTOM\n([\s\S]*?)\nCUSTOM>>>\n/;

const promptsRoot = join(fileURLToPath(new URL("../../../../prompts/workers", import.meta.url)));

function readKindPrompt(kind: Exclude<WorkerKind, "custom">): string {
  return readFileSync(join(promptsRoot, `${kind}.md`), "utf8").trim();
}

const EARLY_EXIT_RULE = `
## Stop early on unrecoverable blockers
Permission denied, missing credentials, unreachable network: stop at once, no diagnostic loops. One empty web_search is a retry with different words, then stop.
`.trim();

const ARTIFACT_RULE = `
## Return compactly
Your final report is private evidence for the parent agent, never a chat message. Keep it under 1,200 characters: decision-ready findings, artifact paths, blockers. Long output goes under \`/shared/worker-results/\` (or the exact path requested) — verify the file, return its path plus a short summary. No bulk rows, raw HTML, or long logs in the report. You have no voice in any room.
`.trim();

const BUDGET_RULE = (maxSteps: number) => `
## Step budget: ${maxSteps} steps
You have max ${maxSteps} tool steps. After step ${Math.max(maxSteps - 2, 1)}, stop calling tools and write your Findings report with what you have, even if partial. Partial evidence beats silence.
`.trim();


/**
 * Standing method for one worker run.
 * Built-ins load prompts/workers/<kind>.md; custom uses the parent-supplied instructions
 * (with a thin safety wrapper so the worker still cannot contact the user).
 * maxSteps injects the budget rule so the worker stops tooling in time to report.
 */
export function workerPreambleFor(kind: WorkerKind, customInstructions?: string, maxSteps?: number): string {
  const budget = BUDGET_RULE(maxSteps ?? 10);
  if (kind === "custom") {
    const body = (customInstructions ?? "").trim();
    if (!body) throw new Error("custom worker kind requires instructions.");
    return [
      "# Custom worker",
      "",
      "You are a background worker.You run on a Debian Linux box with node, npm, python3, pip, git, build-essential, chromium preinstalled. Verify with \`command -v <tool>\` before anything else. Never ask the person to install programs — installs happen here via \`bash\`, and only as a last resort (\`sudo apt-get install -y <pkg>\`). Prefer \`npx\` and system binaries. Never \`brew install\` on this box",
      "If the screen needs the person, end with `NEEDS_PERSON: <one instruction>`.",
      "",
      "End with:",
      "**Findings:**",
      "**What I did:**",
      "**Blockers:**",
      "",
      "## Standing method (from parent)",
      "",
      body,
      "",
      budget,
      "",
      EARLY_EXIT_RULE,
      "",
      ARTIFACT_RULE,
    ].join("\n");
  }
  return [readKindPrompt(kind), "", budget, "", EARLY_EXIT_RULE, "", ARTIFACT_RULE].join("\n");
}

/** Persist kind (+ optional custom prompt) inside job_description without a schema migration. */
export function packWorkerJobDescription(input: {
  kind: WorkerKind;
  jobDescription: string;
  instructions?: string;
}): string {
  const job = input.jobDescription.trim();
  if (input.kind === "custom") {
    const instructions = (input.instructions ?? "").trim();
    if (!instructions) throw new Error("custom worker kind requires instructions.");
    return `WORKER_KIND=custom\n<<<CUSTOM\n${instructions}\nCUSTOM>>>\n${job}`;
  }
  return `WORKER_KIND=${input.kind}\n${job}`;
}

export function unpackWorkerJobDescription(raw: string): {
  kind: WorkerKind;
  jobDescription: string;
  instructions?: string;
} {
  const custom = raw.match(CUSTOM_BLOCK);
  if (custom) {
    return {
      kind: "custom",
      instructions: custom[1]?.trim() || undefined,
      jobDescription: raw.slice(custom[0].length).trim(),
    };
  }
  const kindMatch = raw.match(META_KIND);
  if (kindMatch) {
    const kind = kindMatch[1] as WorkerKind;
    if ((WORKER_KINDS as readonly string[]).includes(kind) && kind !== "custom") {
      return { kind, jobDescription: raw.slice(kindMatch[0].length).trim() };
    }
  }
  // Legacy rows (pre-kind): treat as computer — old worker.md was desktop-heavy.
  return { kind: "computer", jobDescription: raw };
}

export function isWorkerKind(value: string): value is WorkerKind {
  return (WORKER_KINDS as readonly string[]).includes(value);
}
