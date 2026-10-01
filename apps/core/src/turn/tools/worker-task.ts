/** Soft validation before spawn_worker: returns hint for the model to fix task text. */
export function validateWorkerTask(task: string): { ok: true } | { ok: false; hint: string } {
  const trimmed = task.trim();
  if (trimmed.length < 40) {
    return { ok: false, hint: "Task is too short. Include Goal, Inputs, Method, Success check, and Return format." };
  }
  return { ok: true };
}
