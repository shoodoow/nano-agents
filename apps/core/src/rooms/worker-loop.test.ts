import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  compactTranscript,
  compactionThreshold,
  isLookOnlyStep,
  isReadOnlyShell,
  resumableTranscript,
  transcriptForStorage,
} from "./worker-loop.js";

const call = (id: string, toolName: string, input: unknown): ModelMessage =>
  ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName, input }] }) as ModelMessage;
const answer = (id: string, toolName: string, value: string): ModelMessage =>
  ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value } }] }) as ModelMessage;

describe("isReadOnlyShell", () => {
  it("treats looking as looking", () => {
    for (const command of [
      "cat a.txt && ls -la",
      "sed -n '100,200p' cli.js",
      "grep -n width dist/cli.js | head -20",
      "D=/x/dist; node -e \"const s=require('fs').readFileSync('$D/a.js','utf8'); console.log(s.slice(0,200))\"",
      "npx --yes hyperframes@0.6.51 docs gsap 2>&1 | head -140 | cat",
      "find . -name SKILL.md 2>/dev/null",
      "cd ~/work/x && cat index.html",
    ]) {
      expect([command, isReadOnlyShell(command)]).toEqual([command, true]);
    }
  });

  it("treats changing or running things as doing", () => {
    for (const command of [
      "npx hyperframes render -o out.mp4",
      "echo hi > file.txt",
      "sed -i 's/a/b/' file",
      "python3 build.py",
      "mkdir -p work && cd work",
      "find . -name '*.tmp' -delete",
      "npm install",
    ]) {
      expect([command, isReadOnlyShell(command)]).toEqual([command, false]);
    }
  });
});

describe("isLookOnlyStep", () => {
  it("is true only when every call in the step just looks", () => {
    expect(isLookOnlyStep([{ name: "read", input: { path: "/a" } }, { name: "bash", input: { command: "ls" } }])).toBe(true);
    expect(isLookOnlyStep([{ name: "read", input: { path: "/a" } }, { name: "write", input: { path: "/b", body: "x" } }])).toBe(false);
    expect(isLookOnlyStep([{ name: "bash", input: { command: "npm run build" } }])).toBe(false);
    expect(isLookOnlyStep([])).toBe(false);
  });
});

describe("compactTranscript", () => {
  const big = "x".repeat(5_000);
  const transcript: ModelMessage[] = [
    { role: "user", content: `the brief ${big}` },
    call("1", "bash", { command: "cat big" }),
    answer("1", "bash", big),
    call("2", "write", { path: "/a.html", body: big }),
    answer("2", "write", "Wrote the file."),
    call("3", "bash", { command: "ls" }),
    answer("3", "bash", big),
  ];

  it("trims old output and old file bodies, keeps the brief and recent steps whole", () => {
    const out = compactTranscript(transcript, { keepRecent: 2, toolChars: 200, inputChars: 100 });
    expect(out).toHaveLength(transcript.length);
    expect(out[0]).toBe(transcript[0]);
    expect(JSON.stringify(out[2]).length).toBeLessThan(700);
    expect(JSON.stringify(out[2])).toContain("trimmed");
    expect(JSON.stringify(out[3]).length).toBeLessThan(500);
    expect(out[5]).toBe(transcript[5]);
    expect(out[6]).toBe(transcript[6]);
    // Calls and results stay paired.
    expect(out.map((message) => message.role)).toEqual(transcript.map((message) => message.role));
  });

  it("drops pictures when storing and fits the size limit", () => {
    const withImage: ModelMessage[] = [
      { role: "user", content: "brief" },
      call("1", "computer_screenshot", {}),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "computer_screenshot",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Screenshot saved at /shared/a.png" },
                { type: "file", mediaType: "image/png", data: { type: "data", data: "A".repeat(50_000) } },
              ],
            },
          },
        ],
      } as never,
    ];
    const stored = transcriptForStorage(withImage);
    const text = JSON.stringify(stored);
    expect(text.length).toBeLessThan(2_000);
    expect(text).toContain("Screenshot saved at /shared/a.png");
    expect(text).toContain("no longer in view");
    const tight = transcriptForStorage(transcript, 3_000);
    expect(JSON.stringify(tight).length).toBeLessThan(8_000);
  });
});

describe("resumableTranscript", () => {
  it("drops a tool call that never got its result", () => {
    const cut: unknown[] = [
      { role: "user", content: "brief" },
      call("1", "bash", { command: "ls" }),
      answer("1", "bash", "a b c"),
      call("2", "bash", { command: "npm run build" }),
    ];
    const out = resumableTranscript(cut);
    expect(out).toHaveLength(3);
    expect(out.at(-1)?.role).toBe("tool");
  });

  it("keeps a complete conversation and ignores junk", () => {
    const whole: unknown[] = [{ role: "user", content: "brief" }, call("1", "bash", {}), answer("1", "bash", "ok"), null, "x"];
    expect(resumableTranscript(whole)).toHaveLength(3);
    expect(resumableTranscript("nope" as never)).toEqual([]);
  });
});

describe("compactionThreshold", () => {
  it("scales with the model window inside sane bounds", () => {
    expect(compactionThreshold(1_000_000)).toBe(90_000);
    expect(compactionThreshold(32_000)).toBe(24_000);
    expect(compactionThreshold(null)).toBe(70_400);
  });
});
