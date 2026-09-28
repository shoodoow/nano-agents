import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { conversations } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { claimDue, createRoutine } from "./routines.js";

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
