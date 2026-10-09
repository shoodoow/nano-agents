import { describe, expect, it } from "vitest";
import {
  claimedWrittenPaths,
  classifyWorkerEnding,
  collectWorkerFallback,
  collectWorkerText,
  isEmptyWorkerReport,
  isToolDigestFallback,
  resolveWorkerEnding,
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

  it("prefers a Findings block over later next-step narration", () => {
    const report = collectWorkerText({
      text: "",
      steps: [
        { text: "Findings: Chrome DevTools was down.\nWhat I did: took a screenshot.\nBlockers: none" },
        { text: "I'll relaunch Chrome with debugging and retry." },
      ],
    });
    expect(report.startsWith("Findings:")).toBe(true);
    expect(report).toContain("DevTools was down");
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
    const ending = classifyWorkerEnding("The page shows an Instagram login wall. Let me take a fresh screenshot to confirm.", false);
    expect(ending.kind).toBe("needs_person");
    if (ending.kind === "needs_person") expect(ending.result).toMatch(/NEEDS_PERSON:/);
  });

  it("flags bare next-step narration with no tools as a stall", () => {
    expect(classifyWorkerEnding("Let me open the file and check.", false).kind).toBe("stall");
    expect(classifyWorkerEnding("", false).kind).toBe("stall");
  });

  it("trusts next-step narration when tools already ran (Emily Chrome / Jenny objkt)", () => {
    expect(
      classifyWorkerEnding("The DevTools endpoint refused. I'll relaunch Chrome and retry.", true).kind,
    ).toBe("report");
    expect(
      classifyWorkerEnding("The web_fetch returned empty (JS-heavy). Let me open objkt.com in Chromium.", true).kind,
    ).toBe("report");
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

describe("resolveWorkerEnding", () => {
  it("delivers a tool digest as done when tools ran with empty final text", () => {
    const ending = resolveWorkerEnding({
      text: "",
      steps: [{ text: "", toolResults: [{ toolName: "bash", output: "chromium relaunched" }], toolCalls: [{}] }],
    });
    expect(ending.kind).toBe("report");
    if (ending.kind === "report") {
      expect(ending.result).toContain("bash");
      expect(ending.result).toContain("chromium relaunched");
    }
  });

  it("still stalls when nothing ran and the model only narrated", () => {
    expect(resolveWorkerEnding({ text: "Let me open Chromium next.", steps: [] }).kind).toBe("stall");
  });
});

describe("isToolDigestFallback", () => {
  it("is true when tools ran but no text was ever written", () => {
    expect(
      isToolDigestFallback({
        text: "",
        steps: [{ text: "", toolResults: [{ toolName: "read", output: "file contents" }], toolCalls: [{}] }],
      }),
    ).toBe(true);
  });

  it("is false when a Findings report exists", () => {
    expect(
      isToolDigestFallback({
        text: "Findings: done.",
        steps: [{ text: "Findings: done.", toolResults: [{ toolName: "read", output: "x" }] }],
      }),
    ).toBe(false);
  });

  it("is false when nothing ran at all", () => {
    expect(isToolDigestFallback({ text: "", steps: [] })).toBe(false);
  });
});
