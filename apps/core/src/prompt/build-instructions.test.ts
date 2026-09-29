import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildInstructions } from "./build-instructions.js";

const promptUrl = new URL("../../../../prompts/system.md", import.meta.url);
const systemPrompt = readFileSync(promptUrl, "utf8").trim();

describe("buildInstructions", () => {
  it("places the system prompt and the description after it", () => {
    const description = "Auditor for the books.";
    const result = buildInstructions(description);
    expect(result.indexOf(systemPrompt)).toBe(0);
    expect(result.endsWith(description)).toBe(true);
  });

  it("changes only the tail when the description changes", () => {
    const first = buildInstructions("First hire.");
    const second = buildInstructions("Second hire.");
    expect(first.slice(0, systemPrompt.length)).toBe(second.slice(0, systemPrompt.length));
    expect(first).toContain("First hire.");
    expect(second).toContain("Second hire.");
    expect(second).not.toContain("First hire.");
  });
});
