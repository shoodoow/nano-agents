/**
 * Soft validation before spawn_worker.
 * pkill-chromium lines are auto-stripped (not a retry-burning error): the
 * guard intent is preserved without costing the model a full 10k-token step
 * to retype the same brief. Returns the cleaned task to run.
 */
const BRIEF_MARKERS = [
  { key: "goal", test: /\bgoal\b/i },
  { key: "inputs", test: /\binputs?\b/i },
  { key: "method", test: /\bmethod\b/i },
  { key: "success check", test: /\bsuccess\b/i },
  { key: "return format", test: /\breturn\b/i },
];

export function validateWorkerTask(task: string): { ok: true; task: string } | { ok: false; hint: string } {
  const trimmed = task.trim();
  if (trimmed.length < 40) {
    return { ok: false, hint: "Task is too short. Include Goal, Inputs, Method, Success check, and Return format." };
  }
  // A vague brief burns a whole worker run (10 model steps + screenshots) for
  // nothing. Fail fast here — one retry with a complete brief beats a dumb worker.
  const missing = BRIEF_MARKERS.filter((marker) => !marker.test.test(trimmed)).map((marker) => marker.key);
  if (missing.length > 2) {
    return {
      ok: false,
      hint: `Task is missing ${missing.join(", ")}. A worker starts blank: restate the brief with Goal, Inputs, Method, Success check, and Return format (Findings / What I did / Blockers with proof).`,
    };
  }

  const cleaned = trimmed
    .split("\n")
    .filter((line) => !/\bpkill\b.*chrom|killall\s+chromium|close all chrome|close every chrome/i.test(line))
    .join("\n")
    .trim();
  const taskToRun = cleaned.length >= 40 ? cleaned : trimmed;
  const lower = taskToRun.toLowerCase();

  // const isDesktop =
  //   /instagram|chromium|chrome\b|desktop|browser|facebook|linkedin|noVNC|computer_/.test(lower) ||
  //   /https?:\/\//.test(trimmed);
  // if (isDesktop && !/computer_screenshot|screenshot/.test(lower)) {
  //   return {
  //     ok: false,
  //     hint: "Desktop or browser tasks must include computer_screenshot in Method (see before/after navigation). Describe visible UI; skip OCR unless the person required it.",
  //   };
  // }

  if (/\bocr\b|tesseract/.test(lower) && !/\bocr required\b|must ocr/.test(lower)) {
    return {
      ok: false,
      hint: "Prefer text/snapshot (web_fetch, dump-dom, chrome-devtools) or a plain screen description. Drop OCR/tesseract unless the person explicitly asked for OCR.",
    };
  }

  return { ok: true, task: taskToRun };
}
