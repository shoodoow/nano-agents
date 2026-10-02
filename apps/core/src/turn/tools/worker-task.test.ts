import { describe, expect, it } from "vitest";
import { validateWorkerTask } from "./worker-task.js";

describe("validateWorkerTask", () => {
  it("auto-strips chromium kills instead of retry-burning", () => {
    const r = validateWorkerTask(
      "Goal: check IG. Inputs: url. Method: pkill chromium then open.\ncomputer_screenshot first, then navigate. Success: done. Return: text.",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task).not.toMatch(/pkill/i);
  });

  it("does not require screenshot text (guidance lives in the tool description)", () => {
    const r = validateWorkerTask(
      "Goal: Open https://instagram.com/foo Method: launch chromium and wait 5s Success: page open Return: description",
    );
    expect(r.ok).toBe(true);
  });

  it("accepts screenshot-first desktop task", () => {
    const r = validateWorkerTask(
      "Goal: See IG profile. Inputs: https://instagram.com/getstackbrief/ Method: computer_screenshot first, then navigate if needed. Success: screenshot shows page. Return: Findings.",
    );
    expect(r.ok).toBe(true);
  });

  it("rejects vague briefs missing most markers", () => {
    const r = validateWorkerTask("Go check my instagram page and tell me what you think about it overall today.");
    expect(r.ok).toBe(false);
  });
});
