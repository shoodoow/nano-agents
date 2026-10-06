import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAgentIdentity, buildInstructions } from "./build-instructions.js";

const promptUrl = new URL("../../../../prompts/system.md", import.meta.url);
const systemPrompt = readFileSync(promptUrl, "utf8").trim();

describe("buildInstructions", () => {
  it("does not tell the model that plain text is a private monologue", () => {
    expect(systemPrompt).not.toContain("inner monologue the person never sees");
    expect(systemPrompt).toContain("Plain text is not a message.");
    expect(systemPrompt).toContain("use that timezone and local time");
  });

  it("places the system prompt and the composed identity after it", () => {
    const result = buildInstructions({ name: "Ada", role: "Ledger keeper", personality: "warm, terse", job: "Keep the ledger." });
    expect(result.indexOf(systemPrompt)).toBe(0);
    expect(result).toContain("You are Ada — Ledger keeper.");
    expect(result).toContain("Personality: warm, terse");
    expect(result.endsWith("Job:\nKeep the ledger.")).toBe(true);
  });

  it("omits the personality line when empty and keeps order stable", () => {
    const result = buildInstructions({ name: "Ada", role: "Ledger keeper", personality: "", job: "Keep the ledger." });
    expect(result).not.toContain("Personality:");
    expect(result.indexOf("You are Ada")).toBeGreaterThan(systemPrompt.length);
    expect(result.indexOf("Job:")).toBeGreaterThan(result.indexOf("You are Ada"));
  });

  it("changes only the identity block when the job changes", () => {
    const first = buildInstructions({ name: "Ada", role: "Keeper", personality: "", job: "First hire." });
    const second = buildInstructions({ name: "Ada", role: "Keeper", personality: "", job: "Second hire." });
    expect(first.slice(0, systemPrompt.length)).toBe(second.slice(0, systemPrompt.length));
    expect(first).toContain("First hire.");
    expect(second).toContain("Second hire.");
    expect(second).not.toContain("First hire.");
  });

  it("composes the identity block in fixed order", () => {
    expect(buildAgentIdentity({ name: "Mo", role: "CMO", personality: "", job: "Run marketing." })).toBe(
      "You are Mo — CMO.\n\nJob:\nRun marketing.",
    );
  });
});
