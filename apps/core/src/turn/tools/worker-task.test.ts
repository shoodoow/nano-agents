import { describe, expect, it } from "vitest";
import { validateWorkerTask } from "./worker-task.js";

describe("validateWorkerTask", () => {
  it("rejects killing chromium", () => {
    const r = validateWorkerTask(
      "Goal: check IG. Inputs: url. Method: pkill chromium then open. Success: done. Return: text.",
    );
    expect(r.ok).toBe(false);
  });

  it("requires screenshot for browser tasks", () => {
    const r = validateWorkerTask(
      "Goal: Open https://instagram.com/foo Method: launch chromium and wait 5s Success: page open Return: description",
    );
    expect(r.ok).toBe(false);
  });

  it("accepts screenshot-first desktop task", () => {
    const r = validateWorkerTask(
      "Goal: See IG profile. Inputs: https://instagram.com/getstackbrief/ Method: computer_screenshot first, then navigate if needed. Success: screenshot shows page. Return: Findings.",
    );
    expect(r.ok).toBe(true);
  });
});
