/** Soft validation before spawn_worker: returns hint for the model to fix task text. */
export function validateWorkerTask(task: string): { ok: true } | { ok: false; hint: string } {
  const trimmed = task.trim();
  if (trimmed.length < 40) {
    return { ok: false, hint: "Task is too short. Include Goal, Inputs, Method, Success check, and Return format." };
  }

  const lower = trimmed.toLowerCase();
  if (/\bpkill\b.*chrom|killall\s+chromium|close all chrome|close every chrome/i.test(lower)) {
    return {
      ok: false,
      hint: "Do not kill Chromium — the person may already be logged in on the desktop. Screenshot first, reuse that window, navigate if needed.",
    };
  }

  const isDesktop =
    /instagram|chromium|chrome\b|desktop|browser|facebook|linkedin|noVNC|computer_/.test(lower) ||
    /https?:\/\//.test(trimmed);
  if (isDesktop && !/computer_screenshot|screenshot/.test(lower)) {
    return {
      ok: false,
      hint: "Desktop or browser tasks must include computer_screenshot in Method (see before/after navigation). Describe visible UI; skip OCR unless the person required it.",
    };
  }

  if (/\bocr\b|tesseract/.test(lower) && !/\bocr required\b|must ocr/.test(lower)) {
    return {
      ok: false,
      hint: "Prefer computer_screenshot and a plain description of what is on screen. Drop OCR/tesseract unless the person explicitly asked for OCR.",
    };
  }

  return { ok: true };
}
