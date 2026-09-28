import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { conversations, members, messages } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createAccount, createAgent } from "../roster/roster.js";
import { runTurn } from "./turn.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

describe("runTurn", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("calls the model once for the mentioned agent and once for the owner when nobody is mentioned", async () => {
    const account = await createAccount(db, { name: "Room" });
    const ada = await createAgent(db, account.id, agent("Ada"));
    const bea = await createAgent(db, account.id, agent("Bea"));
    const cy = await createAgent(db, account.id, agent("Cy"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "group", ownerAgentId: cy.id, title: "desk" })
      .returning();
    await db.insert(members).values([ada, bea, cy].map((member) => ({
      conversationId: room!.id,
      accountId: account.id,
      agentId: member.id,
    })));

    const calls: string[] = [];
    await runTurn(db, account.id, room!.id, "@Ada look", async ({ agentId }) => {
      calls.push(agentId);
      return "done";
    });
    expect(calls).toEqual([ada.id]);

    calls.length = 0;
    await runTurn(db, account.id, room!.id, "anyone?", async ({ agentId }) => {
      calls.push(agentId);
      return "owner reply";
    });
    expect(calls).toEqual([cy.id]);

    const stored = await db.select().from(messages).where(eq(messages.conversationId, room!.id));
    expect(stored.filter((message) => message.agentId === ada.id)).toHaveLength(1);
    expect(stored.filter((message) => message.agentId === cy.id)).toHaveLength(1);
    expect(stored.filter((message) => message.agentId === bea.id)).toHaveLength(0);
  });

  it("lets a reply mention the next agent once", async () => {
    const account = await createAccount(db, { name: "Chain" });
    const ada = await createAgent(db, account.id, agent("Ada"));
    const bea = await createAgent(db, account.id, agent("Bea"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "group", ownerAgentId: ada.id, title: "chain" })
      .returning();
    await db.insert(members).values([ada, bea].map((member) => ({
      conversationId: room!.id,
      accountId: account.id,
      agentId: member.id,
    })));
    const calls: string[] = [];
    await runTurn(db, account.id, room!.id, "@Ada start", async ({ agentId }) => {
      calls.push(agentId);
      return agentId === ada.id ? "@Bea your turn" : "finished";
    });
    expect(calls).toEqual([ada.id, bea.id]);
  });

  it("runs overlapping turns one after another", async () => {
    const account = await createAccount(db, { name: "Lock" });
    const owner = await createAgent(db, account.id, agent("Owner"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: owner.id, title: "lock" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: owner.id });

    const log: string[] = [];
    const generate = async () => {
      log.push("start");
      await new Promise((resolve) => setTimeout(resolve, 40));
      log.push("end");
      return "ok";
    };
    await Promise.all([
      runTurn(db, account.id, room!.id, "first", generate),
      runTurn(db, account.id, room!.id, "second", generate),
    ]);
    expect(log).toEqual(["start", "end", "start", "end"]);
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
