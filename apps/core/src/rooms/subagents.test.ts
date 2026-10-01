import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { agents, conversations, delegations, members, messages } from "../db/schema.js";
import { createAccount, createAgent } from "../roster/roster.js";
import { createGroupRoom } from "./rooms.js";
import { runDelegatedTurn } from "./turn.js";
import {
  addGroupMember,
  alreadyDelivered,
  checkWorker,
  claimDelivery,
  hireSubagent,
  listTeam,
  reclaimStaleDelegations,
  recordDelegation,
  runWorker,
  MAX_WORKERS_PER_PARENT,
  spawnWorker,
  stopWorker,
  WorkerCapacityError,
  workerSuccessCue,
} from "./subagents.js";

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
      role: "Teammate",
      jobDescription: "Coordinates.",
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
        role: "Teammate",
        jobDescription: "Researches accounts.",
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

  it("refuses to hire into a private chat and leaves that membership unchanged", async () => {
    const account = await createAccount(db, { name: "Direct" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });

    await expect(
      hireSubagent(db, {
        accountId: account.id,
        conversationId: room!.id,
        parentAgentId: chief.id,
        label: "Researcher",
        role: "Teammate",
        jobDescription: "Researches accounts.",
      }),
    ).rejects.toThrow(/1:1/);

    const still = await db.select().from(members).where(eq(members.conversationId, room!.id));
    expect(still.map((row) => row.agentId)).toEqual([chief.id]);
  });

  it("creates a group without touching a private chat", async () => {
    const account = await createAccount(db, { name: "Group" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const bea = await createAgent(db, account.id, agent("Bea"));
    const [direct] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: direct!.id, accountId: account.id, agentId: chief.id });

    const group = await createGroupRoom(db, {
      accountId: account.id,
      ownerAgentId: chief.id,
      title: "Launch",
      memberIds: [bea.id],
    });
    expect(group.kind).toBe("group");
    expect(group.members.map((row) => row.agentId).sort()).toEqual([bea.id, chief.id].sort());

    const directMembers = await db.select().from(members).where(eq(members.conversationId, direct!.id));
    expect(directMembers.map((row) => row.agentId)).toEqual([chief.id]);
  });

  it("attributes a delegated reply to the parent and does not chain mentions", async () => {
    const account = await createAccount(db, { name: "Delegate" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const bea = await createAgent(db, account.id, agent("Bea"));
    const group = await createGroupRoom(db, {
      accountId: account.id,
      ownerAgentId: chief.id,
      title: "Handoff",
      memberIds: [bea.id],
    });
    const child = await hireSubagent(db, {
      accountId: account.id,
      conversationId: group.id,
      parentAgentId: chief.id,
      label: "Researcher",
      role: "Teammate",
      jobDescription: "Researches accounts.",
    });
    const delegation = await recordDelegation(db, {
      accountId: account.id,
      conversationId: group.id,
      parentAgentId: chief.id,
      agentId: child.id,
      task: "Score these accounts.",
    });
    const emitted: (typeof messages.$inferSelect)[] = [];
    const bubbles = await runDelegatedTurn(db, {
      accountId: account.id,
      conversationId: group.id,
      runId: randomUUID(),
      parentAgentId: chief.id,
      childAgentId: child.id,
      delegationId: delegation.id,
      task: "Score these accounts.",
      nextTime: () => new Date(),
      emittedMessages: emitted,
      emit: async () => {},
      delegationDepth: 1,
      generate: async () => "@Bea jump in with the scores",
    });
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]?.agentId).toBe(child.id);
    expect(bubbles[0]?.viaAgentId).toBe(chief.id);
    const stored = await db.select().from(messages).where(eq(messages.conversationId, group.id));
    expect(stored.filter((row) => row.agentId === bea.id)).toHaveLength(0);
    expect(stored.filter((row) => row.agentId === child.id)).toHaveLength(1);
  });

  it("runs a hidden worker to a result, stops one, and reclaims a stale one", async () => {
    const account = await createAccount(db, { name: "Workers" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });

    const spawned = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Dig",
      role: "Teammate",
      jobDescription: "Digs through files.",
      task: "Find the ledger.",
    });
    const membership = await db
      .select()
      .from(members)
      .where(and(eq(members.conversationId, room!.id), eq(members.agentId, spawned.workerId)));
    expect(membership).toHaveLength(0);
    const [worker] = await db.select().from(agents).where(eq(agents.id, spawned.workerId));
    expect(worker?.hidden).toBe(true);

    await runWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      childId: spawned.workerId,
      delegationId: spawned.delegationId,
      task: "Find the ledger.",
      generate: async () => "Found three rows.",
    });
    const done = await checkWorker(db, account.id, spawned.workerId);
    expect(done.status).toBe("done");
    expect(done.result).toBe("Found three rows.");

    const running = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Wait",
      role: "Teammate",
      jobDescription: "Waits.",
      task: "Hold.",
    });
    expect(await stopWorker(db, account.id, running.workerId)).toEqual({ stopped: true });
    expect((await checkWorker(db, account.id, running.workerId)).status).toBe("failed");

    const stale = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Lost",
      role: "Teammate",
      jobDescription: "Lost.",
      task: "Hang.",
    });
    await db
      .update(delegations)
      .set({ createdAt: new Date(Date.now() - 10_000) })
      .where(eq(delegations.id, stale.delegationId));
    const reclaimed = await reclaimStaleDelegations(db, 1_000);
    expect(reclaimed.map((row) => row.id)).toContain(stale.delegationId);
    expect((await checkWorker(db, account.id, stale.workerId)).status).toBe("failed");
  });

  it("reuses a free hidden worker instead of inserting another row", async () => {
    const account = await createAccount(db, { name: "Reuse" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });

    const first = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Job",
      role: "Teammate",
      jobDescription: "Runs tasks.",
      task: "Task 1",
    });
    await runWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      childId: first.workerId,
      delegationId: first.delegationId,
      task: "Task 1",
      generate: async () => "Done",
    });
    const again = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Reuse",
      role: "Teammate",
      jobDescription: "Runs tasks.",
      task: "Task 2",
    });
    const [workerRows] = await db
      .select({ value: count() })
      .from(agents)
      .where(and(eq(agents.parentId, chief.id), eq(agents.accountId, account.id), eq(agents.hidden, true)));
    expect(workerRows?.value).toBe(1);
    expect(again.workerId).toBe(first.workerId);
    expect((await checkWorker(db, account.id, again.workerId)).status).toBe("running");
  });

  it("throws WorkerCapacityError when every hidden worker is still running", async () => {
    const account = await createAccount(db, { name: "Full" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    await db.insert(members).values({ conversationId: room!.id, accountId: account.id, agentId: chief.id });

    for (let i = 0; i < MAX_WORKERS_PER_PARENT; i++) {
      await spawnWorker(db, {
        accountId: account.id,
        conversationId: room!.id,
        parentAgentId: chief.id,
        label: `Busy-${i}`,
        role: "Teammate",
        jobDescription: "Runs tasks.",
        task: `Task ${i}`,
      });
    }
    await expect(
      spawnWorker(db, {
        accountId: account.id,
        conversationId: room!.id,
        parentAgentId: chief.id,
        label: "One more",
        role: "Teammate",
        jobDescription: "Runs tasks.",
        task: "Nope",
      }),
    ).rejects.toBeInstanceOf(WorkerCapacityError);
  });

  it("does not count hidden workers toward the teammate hire cap", async () => {
    const account = await createAccount(db, { name: "Split caps" });
    const cmo = await createAgent(db, account.id, agent("CMO"));
    const group = await createGroupRoom(db, {
      accountId: account.id,
      ownerAgentId: cmo.id,
      title: "Marketing",
      memberIds: [],
    });
    for (let i = 0; i < MAX_WORKERS_PER_PARENT; i++) {
      const spawned = await spawnWorker(db, {
        accountId: account.id,
        conversationId: group.id,
        parentAgentId: cmo.id,
        label: `Worker-${i}`,
        role: "Runner",
        jobDescription: "Runs tasks.",
        task: `Task ${i}`,
      });
      await runWorker(db, {
        accountId: account.id,
        conversationId: group.id,
        parentAgentId: cmo.id,
        childId: spawned.workerId,
        delegationId: spawned.delegationId,
        task: `Task ${i}`,
        generate: async () => "ok",
      });
    }
    const social = await hireSubagent(db, {
      accountId: account.id,
      conversationId: group.id,
      parentAgentId: cmo.id,
      label: "Social",
      role: "Social manager",
      jobDescription: "Grow channels.",
    });
    expect(social.hidden).toBe(false);
    const team = await listTeam(db, account.id, cmo.id);
    expect(team.some((m) => m.id === social.id)).toBe(true);
    expect(team.length).toBe(1);
    expect(
      await spawnWorker(db, {
        accountId: account.id,
        conversationId: group.id,
        parentAgentId: cmo.id,
        label: "Reuse slot",
        role: "Runner",
        jobDescription: "Runs tasks.",
        task: "After teammates hire",
      }),
    ).toMatchObject({ status: "running" });
  });

  it("claims delivery exactly once and spots an already-posted result", async () => {
    const account = await createAccount(db, { name: "Delivery" });
    const chief = await createAgent(db, account.id, agent("Chief"));
    const [room] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: chief.id, title: "dm" })
      .returning();
    const spawned = await spawnWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      label: "Dig",
      role: "Researcher",
      jobDescription: "Dig through files.",
      task: "Find the ledger.",
    });
    await runWorker(db, {
      accountId: account.id,
      conversationId: room!.id,
      parentAgentId: chief.id,
      childId: spawned.workerId,
      delegationId: spawned.delegationId,
      task: "Find the ledger.",
      generate: async () => "Found three rows in the ledger for March.",
    });
    expect(await claimDelivery(db, spawned.delegationId)).toBe(true);
    expect(await claimDelivery(db, spawned.delegationId)).toBe(false);
    expect(await alreadyDelivered(db, { accountId: account.id, conversationId: room!.id, parentAgentId: chief.id, result: "short" })).toBe(
      false,
    );
    await db.insert(messages).values({
      accountId: account.id,
      conversationId: room!.id,
      agentId: chief.id,
      body: "Quick note: Found three rows in the ledger for March. Details above.",
    });
    expect(
      await alreadyDelivered(db, {
        accountId: account.id,
        conversationId: room!.id,
        parentAgentId: chief.id,
        result: "Found three rows in the ledger for March.",
      }),
    ).toBe(true);
    expect(workerSuccessCue({ workerId: "w", task: "t", result: "r" })).toContain("Summarize this for the person");
  });

  it("hires a social manager with identity, grows the group, and keeps 1:1 shut", async () => {
    const account = await createAccount(db, { name: "CMO" });
    const cmo = await createAgent(db, account.id, {
      name: "CMO",
      label: "CMO",
      role: "Chief marketing officer",
      personality: "direct, warm",
      jobDescription: "Run marketing and build the team.",
      provider: "openai",
      modelId: "gpt-5",
    });
    const group = await createGroupRoom(db, {
      accountId: account.id,
      ownerAgentId: cmo.id,
      title: "Marketing",
      memberIds: [],
    });
    const social = await hireSubagent(db, {
      accountId: account.id,
      conversationId: group.id,
      parentAgentId: cmo.id,
      label: "Social",
      role: "Social manager",
      personality: "playful, terse",
      jobDescription: "Post daily and report numbers.",
    });
    expect(social.role).toBe("Social manager");
    expect(social.jobDescription).toBe("Post daily and report numbers.");
    const team = await listTeam(db, account.id, cmo.id);
    expect(team.find((m) => m.id === social.id)?.role).toBe("Social manager");

    const designer = await createAgent(db, account.id, agent("Designer"));
    const added = await addGroupMember(db, { accountId: account.id, conversationId: group.id, agentId: designer.id });
    expect(added.agentId).toBe(designer.id);

    const [direct] = await db
      .insert(conversations)
      .values({ accountId: account.id, kind: "direct", ownerAgentId: cmo.id, title: "dm" })
      .returning();
    await expect(addGroupMember(db, { accountId: account.id, conversationId: direct!.id, agentId: designer.id })).rejects.toThrow(
      /1:1/,
    );
  });
});

function agent(name: string) {
  return {
    name,
    label: name,
    role: "Teammate",
    jobDescription: `${name} works here.`,
    provider: "openai",
    modelId: "gpt-5",
  };
}
