/**
 * Soft validation before spawn_worker.
 * pkill-chromium lines are auto-stripped (not a retry-burning error): the
 * guard intent is preserved without costing the model a full step to retype
 * the same brief. Returns the cleaned task to run.
 */
const BRIEF_MARKERS = [
  { key: "goal", test: /\bgoal\b/i },
  { key: "inputs", test: /\binputs?\b/i },
  { key: "method", test: /\bmethod\b/i },
  { key: "success check", test: /\bsuccess\b/i },
  { key: "return format", test: /\breturn\b/i },
];

const LIVE_BROWSER =
  /\b(instagram|facebook|linkedin|twitter|x\.com|tiktok|browser_snapshot|chrome-devtools|signed[- ]?in|login[- ]?gated)\b/i;

export function validateWorkerTask(task: string): { ok: true; task: string } | { ok: false; hint: string } {
  const trimmed = task.trim();
  if (trimmed.length < 40) {
    return { ok: false, hint: "Task is too short. Include Goal, Inputs, Method, Success check, and Return format." };
  }
  // A vague brief burns a whole worker run for nothing. Fail fast here.
  const missing = BRIEF_MARKERS.filter((marker) => !marker.test.test(trimmed)).map((marker) => marker.key);
  if (missing.length > 2) {
    return {
      ok: false,
      hint: `Task is missing ${missing.join(", ")}. A worker starts blank: restate the brief with Goal, Inputs, Method, Success check, and Return format (Findings / What I did / Blockers with proof).`,
    };
  }

  // One worker = one deliverable. Huge mega-briefs never fit the step budget
  // and end with no report. Chain narrow workers instead.
  if (trimmed.length > 4000) {
    return {
      ok: false,
      hint: `Task is too long (${trimmed.length} chars) for one worker step budget. Split into chained narrow workers: first worker produces the plan/file, then spawn the build worker with that file as Input. One deliverable per spawn; raise maxSteps (3-30) only for multi-stage builds that cannot be split.`,
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
  const taskToRun = cleaned.length >= 40 ? cleaned : trimmed;
  const lower = taskToRun.toLowerCase();

  if (/\bocr\b|tesseract/.test(lower) && !/\bocr required\b|must ocr/.test(lower)) {
    return {
      ok: false,
      hint: "Prefer text/snapshot (web_fetch, chrome-devtools browser_snapshot) or a plain screen description. Drop OCR/tesseract unless the person explicitly asked for OCR.",
    };
  }

  if (LIVE_BROWSER.test(taskToRun)) {
    if (!/chrome-devtools|browser_snapshot/.test(lower)) {
      return {
        ok: false,
        hint: "Live-page Method must include read_skill chrome-devtools and browser_snapshot (then click/fill by uid). Do not send bash HTML grepping or headless dump-dom for Instagram/SPA work. Narrow the Goal to one finishable slice.",
      };
    }
    if (/\b(dump-dom|grep\s+.*\.html|curl\s+.*instagram|chromium\s+--headless)\b/i.test(taskToRun)) {
      return {
        ok: false,
        hint: "Remove headless dump-dom / bash HTML / curl scraping from Method. For live pages use chrome-devtools navigate + snapshot + click only.",
      };
    }
    // Mega-audits burn the step budget mid-task with no Findings.
    const asksManyPosts = /\b([5-9]|1\d|[2-9]\d)\s*(most\s+)?(recent\s+)?posts?\b/i.test(taskToRun);
    const alsoThemesOrPlan = /\b(theme|growth plan|format mix|engagement on each)\b/i.test(taskToRun);
    if (asksManyPosts && alsoThemesOrPlan) {
      return {
        ok: false,
        hint: "Brief is too wide for one worker. Spawn a narrow pass first (profile stats, or up to 3 posts), then another worker for the rest. One Goal finish-line per spawn.",
      };
    }
  }

  return { ok: true, task: taskToRun };
}
