/**
 * Soft cleanup before spawn_worker.
 * Why: every rejection costs the dispatcher a full model step (the whole
 * prompt is resent) just to retype the brief, and a keyword check on the
 * wording rejected briefs that were perfectly runnable. Only two things are
 * refused: a brief too short to act on and one too long for a single worker.
 * Chromium-kill lines are stripped rather than rejected. Returns the task to run.
 */
const MIN_TASK_CHARS = 40;
// Generous on purpose: the brief is the worker's whole world, and a rejected
// brief left the person with a promise and nothing running.
const MAX_TASK_CHARS = 16_000;

export function validateWorkerTask(task: string): { ok: true; task: string } | { ok: false; hint: string } {
  const trimmed = task.trim();
  if (trimmed.length < MIN_TASK_CHARS) {
    return {
      ok: false,
      hint: "Task is too short for a worker that starts blank. Say what to produce, the exact URLs or paths to use, and what to report back.",
    };
  }
  if (trimmed.length > MAX_TASK_CHARS) {
    return {
      ok: false,
      hint: `Task is too long (${trimmed.length} chars). Say what to produce, the requirements, the paths or URLs, and what to report back; leave out step-by-step instructions and pasted file contents (name the file instead).`,
    };
  }

  const cleaned = trimmed
    .replace(/\bpkill\b[^\n.]*chrom[^\n.]*/gi, "")
    .replace(/\bkillall\s+chromium\b/gi, "")
    .replace(/\bclose all chrome\b/gi, "")
    .replace(/\bclose every chrome\b/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { ok: true, task: cleaned.length >= MIN_TASK_CHARS ? cleaned : trimmed };
}
