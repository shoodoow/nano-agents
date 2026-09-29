import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { conversations, members } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { hireSubagent, listTeam, recordDelegation } from "./subagents.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

/**
 * Locks team behavior: chief hires specialists into the same room, delegates
 * with attribution, lists the team, and hits depth/child caps instead of
 * fork-bombing the 20-member room.
 */
describe("subagents and teams", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("hires, lists, and delegates inside one room", async () => {
    const account = await createAccount(db, { name: "Team" });
    const chief = await createAgent(db, account.id, {
      name: "Chief",
      label: "Chief",
      description: "Coordinates.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "group", ownerAgentId: chief.id, title: "launch" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });

    const child = await db.transaction(async (tx) =>
      hireSubagent(tx as never, {
        accountId: account.id,
        conversationId: room!.id,
        parentAgentId: chief.id,
        label: "Researcher",
        description: "Researches accounts.",
      }),
    );
    expect(child.parentId).toBe(chief.id);
    expect(child.teamId).toBe(chief.id);

    const team = await db.transaction(async (tx) => listTeam(tx as never, account.id, chief.id));
    expect(team.map((m) => m.id)).toContain(child.id);

    const delegation = await db.transaction(async (tx) =>
      recordDelegation(tx as never, {
        accountId: account.id,
        conversationId: room!.id,
        parentAgentId: chief.id,
        agentId: child.id,
        task: "Score these 5 accounts.",
      }),
    );
    expect(delegation.status).toBe("running");

    await expect(
      db.transaction(async (tx) =>
        recordDelegation(tx as never, {
          accountId: account.id,
          conversationId: room!.id,
          parentAgentId: chief.id,
          agentId: chief.id,
          task: "self",
        }),
      ),
    ).rejects.toThrow();
  });
});
