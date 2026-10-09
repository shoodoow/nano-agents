import { describe, expect, it } from "vitest";
import { validateWorkerTask } from "./worker-task.js";

describe("validateWorkerTask", () => {
  it("auto-strips chromium kills instead of retry-burning", () => {
    const r = validateWorkerTask(
      "Check the Instagram profile: read_skill chrome-devtools, pkill chromium then browser_snapshot and report the counts.",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task).not.toMatch(/pkill/i);
  });

  it("accepts a plain-language brief without section labels", () => {
    const r = validateWorkerTask(
      "Check what exists in the home directory and /shared. Run ls -la on both and list any hyperframes.json you find.",
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a brief too short to act on", () => {
    const r = validateWorkerTask("check my instagram");
    expect(r.ok).toBe(false);
  });

  it("accepts a long, complete brief and rejects only an absurdly long one", () => {
    expect(validateWorkerTask(`Build everything. ${"x".repeat(4100)}`).ok).toBe(true);
    const r = validateWorkerTask(`Build everything. ${"x".repeat(17000)}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/too long/i);
  });
});
