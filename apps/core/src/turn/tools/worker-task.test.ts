import { describe, expect, it } from "vitest";
import { validateWorkerTask } from "./worker-task.js";

describe("validateWorkerTask", () => {
  it("auto-strips chromium kills instead of retry-burning", () => {
    const r = validateWorkerTask(
      "Goal: check IG. Inputs: url. Method: read_skill chrome-devtools, pkill chromium then browser_snapshot. Success: done. Return: Findings.",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task).not.toMatch(/pkill/i);
  });

  it("requires chrome-devtools/snapshot for live Instagram briefs", () => {
    const r = validateWorkerTask(
      "Goal: Open https://instagram.com/foo Method: launch chromium and wait 5s Success: page open Return: description",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/chrome-devtools/i);
  });

  it("rejects bash HTML / headless dump methods on live pages", () => {
    const r = validateWorkerTask(
      "Goal: Audit IG. Inputs: https://instagram.com/foo Method: read_skill chrome-devtools then chromium --headless --dump-dom and grep the html. Success: numbers. Return: Findings.",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/dump-dom|bash/i);
  });

  it("rejects mega Instagram audits that ask for many posts plus themes", () => {
    const r = validateWorkerTask(
      [
        "Goal: Full Instagram audit.",
        "Inputs: https://www.instagram.com/getstackbrief/",
        "Method: read_skill chrome-devtools, browser_snapshot, open 9 most recent posts and note content themes and growth plan.",
        "Success: all metrics.",
        "Return: Findings / What I did / Blockers.",
      ].join("\n"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/narrow|too wide/i);
  });

  it("accepts a narrow chrome-devtools profile brief", () => {
    const r = validateWorkerTask(
      [
        "Goal: Read exact follower/following/post counts for @getstackbrief.",
        "Inputs: https://www.instagram.com/getstackbrief/",
        "Method: read_skill chrome-devtools; browser_navigate to the URL; browser_snapshot; read counts from the snapshot. No bash HTML.",
        "Success: three exact integers from the page.",
        "Return: Findings / What I did / Blockers.",
      ].join("\n"),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects vague briefs missing most markers", () => {
    const r = validateWorkerTask("Go check my instagram page and tell me what you think about it overall today.");
    expect(r.ok).toBe(false);
  });

  it("rejects oversize mega-briefs with a chaining hint", () => {
    const r = validateWorkerTask(
      ["Goal: Build everything.", "Inputs: repo.", "Method: read a lot.", "Success: done.", "Return: Findings.", "x".repeat(4100)].join(
        "\n",
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toMatch(/chain|narrow|maxSteps/i);
  });
});
