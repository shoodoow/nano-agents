import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildInstructions } from "../prompt/build-instructions.js";
import { buildContext, roomLine } from "./context.js";
import { getDb } from "../db/client.js";
import { conversations, messages } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { runTurn } from "../rooms/turn.js";

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
    const long = buildContext({
      ...agent,
      accountId: "6270c871-e778-44e2-ad9b-cf8c639da2fa",
      agentId: "11111111-1111-1111-1111-111111111111",
      summary: [],
      messages: [],
    });
    expect(long.openai.promptCacheKey).toHaveLength(64);
    expect(context.openai.promptCacheRetention).toBe("24h");
    expect("truncation" in context.openai).toBe(false);
  });

  it("grounds the room situation as the first tail line", () => {
    expect(roomLine({ title: "Group 1", kind: "group", members: ["Grok", "Jimmy", "Mossy"], selfName: "Jimmy" })).toBe(
      'Room "Group 1" (group of 3). Members: Grok, Jimmy, Mossy. You are Jimmy — reply only when mentioned; members wake each other with @Name, a leading @Name is a direct handoff to that member.',
    );
    const withRoom = buildContext({
      ...agent,
      summary: [],
      messages: [{ body: "hi" }],
      room: { title: "Group 1", kind: "group", members: ["Jimmy", "Mossy"], selfName: "Jimmy" },
    });
    expect(withRoom.tail.startsWith('Room "Group 1"')).toBe(true);
    expect(withRoom.prefix.includes("Group 1")).toBe(false);
  });
});

describe("runTurn prefix", () => {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
  const db = getDb(databaseUrl);

  afterAll(async () => {
    await db.$client.end();
  });

  it("reuses the prefix on the next turn and stores the reported cache read tokens", async () => {
    const account = await createAccount(db, { name: "Cache" });
    const owner = await createAgent(db, account.id, {
      name: "Ada",
      label: "Ada",
      description: "Keep the ledger.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: owner.id, title: "cache" })
      .returning();
    const prefixes: string[] = [];
    const tails: string[] = [];
    const generate = async (input: { prefix: string; tail: string }) => {
      prefixes.push(input.prefix);
      tails.push(input.tail);
      return { text: "noted", cacheReadTokens: 40 };
    };
    await runTurn(db, account.id, room!.id, "first", generate);
    await runTurn(db, account.id, room!.id, "second", generate);
    expect(prefixes[0]).toBe(prefixes[1]);
    expect(prefixes[1]?.includes("noted")).toBe(false);
    expect(tails[1]?.includes("noted")).toBe(true);
    const stored = await db.select().from(messages).where(eq(messages.conversationId, room!.id));
    expect(stored.filter((message) => message.agentId).map((message) => message.cacheReadTokens)).toEqual([40, 40]);
  });
});
