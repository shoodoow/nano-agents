import { describe, expect, it } from "vitest";
import { buildInstructions } from "./build-instructions.js";
import { buildContext } from "./context.js";

const agent = {
  accountId: "account-1",
  agentId: "agent-1",
  promptVersion: 3,
  description: "Keep the ledger.",
};

describe("buildContext", () => {
  it("keeps the prefix stable and puts the summary and the new message after it", () => {
    const first = buildContext({
      ...agent,
      summary: [{ key: "decisions", body: "Ship on Friday." }],
      messages: [{ body: "first note" }],
    });
    const second = buildContext({
      ...agent,
      summary: [{ key: "decisions", body: "Ship on Monday." }],
      messages: [{ body: "second note" }],
    });

    expect(first.prefix).toBe(buildInstructions(agent.description));
    expect(first.prefix).toBe(second.prefix);
    expect(first.prefix.includes("Ship on Friday.")).toBe(false);
    expect(first.prefix.includes("first note")).toBe(false);
    expect(first.tail.includes("Ship on Friday.")).toBe(true);
    expect(first.tail.includes("first note")).toBe(true);
    expect(second.tail.includes("second note")).toBe(true);
  });

  it("marks only the prefix for Anthropic and keys the OpenAI cache by account, agent, and prompt version", () => {
    const context = buildContext({
      ...agent,
      summary: [{ key: "topics", body: "Billing." }],
      messages: [{ body: "hello" }],
    });
    expect(context.anthropic.prefix.cacheControl).toEqual({ type: "ephemeral" });
    expect(context.anthropic.tail).toEqual({ body: context.tail });
    expect(context.openai.promptCacheKey).toBe("account-1:agent-1:3");
    expect(context.openai.promptCacheRetention).toBe("24h");
    expect("truncation" in context.openai).toBe(false);
  });
});
