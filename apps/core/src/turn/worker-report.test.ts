import { describe, expect, it } from "vitest";
import {
  claimedWrittenPaths,
  classifyWorkerEnding,
  collectWorkerFallback,
  collectWorkerText,
  isEmptyWorkerReport,
} from "./worker-report.js";

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

  it("omits screenshot base64 so the parent only sees the path", () => {
    const note = collectWorkerFallback({
      text: "",
      steps: [
        {
          text: "",
          toolResults: [
            {
              toolName: "computer_screenshot",
              output: {
                path: "/shared/screenshots/ada/shot.png",
                width: 1280,
                height: 800,
                pngBase64: "A".repeat(8_000),
              },
            },
          ],
        },
      ],
    });
    expect(note).toContain("/shared/screenshots/ada/shot.png");
    expect(note).not.toContain("AAAA");
    expect(note).toContain("[omitted");
  });
});

describe("isEmptyWorkerReport", () => {
  it("rejects the placeholder the room used to show", () => {
    expect(isEmptyWorkerReport("The worker finished with no output.")).toBe(true);
    expect(isEmptyWorkerReport("Findings: (no output)\nWhat I did: nothing")).toBe(true);
    expect(isEmptyWorkerReport("Findings: 120 followers")).toBe(false);
  });
});

describe("classifyWorkerEnding", () => {
  it("accepts a labeled report", () => {
    const ending = classifyWorkerEnding("Findings: 120 followers.\nWhat I did: opened the profile.", false);
    expect(ending.kind).toBe("report");
  });

  it("trusts text when real tool work ran, even without labels", () => {
    const ending = classifyWorkerEnding("The profile has 120 followers and a link in bio.", true);
    expect(ending.kind).toBe("report");
  });

  it("turns the Emily login-wall stall into a sign-in handoff", () => {
    // The exact text that was recorded as a false success.
    const ending = classifyWorkerEnding("The page shows an Instagram login wall. Let me take a fresh screenshot to confirm.", false);
    expect(ending.kind).toBe("needs_person");
    if (ending.kind === "needs_person") expect(ending.result).toMatch(/NEEDS_PERSON:/);
  });

  it("flags bare next-step narration with no tools as a stall", () => {
    expect(classifyWorkerEnding("Let me open the file and check.", false).kind).toBe("stall");
    expect(classifyWorkerEnding("", false).kind).toBe("stall");
  });

  it("flags next-step narration as a stall even when tools ran (Jenny/objkt case)", () => {
    expect(
      classifyWorkerEnding("The web_fetch returned empty (JS-heavy). Let me open objkt.com in Chromium.", true).kind,
    ).toBe("stall");
  });

  it("does not treat the word captcha alone as a person gate", () => {
    expect(classifyWorkerEnding("The overlay looks like a captcha. Let me close it.", false).kind).toBe("stall");
  });

  it("collects paths the report claims it wrote", () => {
    expect(claimedWrittenPaths("I saved the verdict to /shared/worker-results/hackerone-verdict.md.")).toEqual([
      "/shared/worker-results/hackerone-verdict.md",
    ]);
    expect(claimedWrittenPaths("The file /shared/worker-results/missing.md was not found.")).toEqual([]);
  });

  it("passes an explicit NEEDS_PERSON line straight through as a report", () => {
    const ending = classifyWorkerEnding("NEEDS_PERSON: Sign in to Instagram @getstackbrief", false);
    expect(ending.kind).toBe("report");
  });
});
