import { describe, expect, it } from "vitest";
import { collectWorkerFallback, collectWorkerText, isEmptyWorkerReport } from "./worker-report.js";

describe("collectWorkerText", () => {
  it("uses an earlier step when the final step is only a tool call", () => {
    const report = collectWorkerText({
      text: "",
      steps: [
        { text: "Findings: bio is empty.\nWhat I did: opened the profile." },
        { text: "", toolResults: [{ toolName: "computer_screenshot", output: "png" }] },
      ],
    });
    expect(report).toContain("Findings: bio is empty.");
  });

  it("lifts Findings out of reasoning when OpenRouter left content empty", () => {
    const report = collectWorkerText({
      text: "",
      reasoningText: "I should wrap up.\nFindings: 120 followers.\nWhat I did: fetched the page.\nBlockers: login wall.",
    });
    expect(report.startsWith("Findings:")).toBe(true);
    expect(report).toContain("120 followers");
    expect(report.startsWith("I should wrap up")).toBe(false);
  });

  it("returns nothing when the model sent neither text nor a report", () => {
    expect(collectWorkerText({ text: "", reasoningText: "thinking about chrome" })).toBe("");
  });
});

describe("collectWorkerFallback", () => {
  it("keeps the last tool lines so the parent can still answer", () => {
    const note = collectWorkerFallback({
      text: "",
      steps: [{ text: "", toolResults: [{ toolName: "web_fetch", output: { value: "Stackbrief — 120 posts" } }] }],
    });
    expect(note).toContain("web_fetch");
    expect(note).toContain("120 posts");
  });
});

describe("isEmptyWorkerReport", () => {
  it("rejects the placeholder the room used to show", () => {
    expect(isEmptyWorkerReport("The worker finished with no output.")).toBe(true);
    expect(isEmptyWorkerReport("Findings: (no output)\nWhat I did: nothing")).toBe(true);
    expect(isEmptyWorkerReport("Findings: 120 followers")).toBe(false);
  });
});
