import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { conversations, members, messages } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { claimDue, createRoutine, runDue } from "./routines.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

describe("routines", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("lets only one of two workers claim a due job", async () => {
    const account = await createAccount(db, { name: "Schedule" });
    const owner = await createAgent(db, account.id, agent("Ada"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: owner.id, title: "morning" })
      .returning();
    await createRoutine(db, account.id, {
      agentId: owner.id,
      conversationId: room!.id,
      body: "Good morning.",
      cron: "*/15 * * * *",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const [first, second] = await Promise.all([claimDue(db), claimDue(db)]);
    const claimed = [first, second].filter((job) => job !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe("running");
  });

  it("runs a mentioned routine through one model call and leaves an unmentioned routine to the owner", async () => {
    const account = await createAccount(db, { name: "Due" });
    const ada = await createAgent(db, account.id, agent("Ada"));
    const bea = await createAgent(db, account.id, agent("Bea"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "group", ownerAgentId: bea.id, title: "due" })
      .returning();
    await db.insert(members).values([ada, bea].map((member) => ({
      conversationId: room!.id,
      accountId: account.id,
      agentId: member.id,
    })));
    await createRoutine(db, account.id, {
      agentId: ada.id,
      conversationId: room!.id,
      body: "@Ada check the ledger",
      cron: "*/15 * * * *",
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const calls: string[] = [];
    const replies = await runDue(db, async ({ agentId }) => {
      calls.push(agentId);
      return "checked";
    });
    expect(calls).toEqual([ada.id]);
    expect(replies?.map((reply) => reply.agentId)).toEqual([ada.id]);
    const stored = await db.select().from(messages).where(eq(messages.conversationId, room!.id));
    expect(stored.some((message) => message.body === "checked" && message.agentId === ada.id)).toBe(true);

    await createRoutine(db, account.id, {
      agentId: bea.id,
      conversationId: room!.id,
      body: "anyone there",
      cron: "*/15 * * * *",
      nextRunAt: new Date(Date.now() - 30_000).toISOString(),
    });
    calls.length = 0;
    await runDue(db, async ({ agentId }) => {
      calls.push(agentId);
      return "owner here";
    });
    expect(calls).toEqual([bea.id]);
  });
});

function agent(name: string) {
  return {
    name,
    label: name,
    description: `${name} works here.`,
    provider: "openai",
    modelId: "gpt-5",
  };
}
