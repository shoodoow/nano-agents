import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildInstructions } from "./build-instructions.js";

const fileNames = ["identity", "voice", "autonomy", "security", "memory", "group", "skills"] as const;
const promptsDirectory = new URL("../../../../prompts/", import.meta.url);

function promptText(name: (typeof fileNames)[number]): string {
  return readFileSync(new URL(`${name}.md`, promptsDirectory), "utf8").trim();
}

describe("buildInstructions", () => {
  it("places the static files in order and the description after them", () => {
    const description = "Auditor for the books.";
    const result = buildInstructions(description);
    let cursor = 0;
    for (const name of fileNames) {
      const part = promptText(name);
      const at = result.indexOf(part, cursor);
      expect(at).toBeGreaterThanOrEqual(cursor);
      cursor = at + part.length;
    }
    expect(result.slice(cursor)).toContain(description);
  });

  it("changes only the tail when the description changes", () => {
    const first = buildInstructions("First hire.");
    const second = buildInstructions("Second hire.");
    const skills = promptText("skills");
    const splitAt = first.indexOf(skills) + skills.length;
    expect(second.slice(0, splitAt)).toBe(first.slice(0, splitAt));
    expect(first).toContain("First hire.");
    expect(second).toContain("Second hire.");
    expect(second).not.toContain("First hire.");
  });
});
