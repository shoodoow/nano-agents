import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "./db/client.js";
import { agents, conversations, messages, proposals } from "./db/schema.js";
import { approve, propose, reject } from "./proposals.js";
import { createAccount, createAgent } from "./roster.js";
import { startServer } from "./server.js";
import { runTurn } from "./turn.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

describe("proposals", () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it("stores a cited proposal, and refuses one with no message id", async () => {
    const room = await openRoom("Cite");
    const message = await saveMessage(room, "Remember the Friday ship.");
    const saved = await propose(db, room.accountId, {
      agentId: room.agentId,
      kind: "memory",
      body: "Ship on Friday.",
      messageIds: [message.id],
    });
    expect(saved.messageIds).toEqual([message.id]);
    expect(saved.status).toBe("pending");
    await expect(
      propose(db, room.accountId, {
        agentId: room.agentId,
        kind: "memory",
        body: "No source.",
        messageIds: [],
      }),
    ).rejects.toThrow(/message/);
  });

  it("rejects without writing the skill or changing the prompt version", async () => {
    const room = await openRoom("Refuse");
    const skillsRoot = await mkdtemp(join(tmpdir(), "nano-proposals-"));
    const skillPath = join(skillsRoot, "letters", "SKILL.md");
    await mkdir(join(skillsRoot, "letters"));
    const original = "---\nname: letters\ndescription: Old.\n---\n\nOld body.\n";
    await writeFile(skillPath, original);
    const message = await saveMessage(room, "Try a new skill.");
    const saved = await propose(db, room.accountId, {
      agentId: room.agentId,
      kind: "skill",
      body: "---\nname: letters\ndescription: New.\n---\n\nNew body.\n",
      messageIds: [message.id],
    });
    await reject(db, room.accountId, saved.id);
    expect(await readFile(skillPath, "utf8")).toBe(original);
    expect(await promptVersion(room.agentId)).toBe(1);
    await rm(skillsRoot, { recursive: true, force: true });
  });

  it("approves a skill, writes that file, and increments the prompt version", async () => {
    const room = await openRoom("Accept");
    const skillsRoot = await mkdtemp(join(tmpdir(), "nano-proposals-"));
    const message = await saveMessage(room, "Learn the letter voice.");
    const body = "---\nname: letters\ndescription: Writes letters.\n---\n\nWrite in the client's voice.\n";
    const saved = await propose(db, room.accountId, {
      agentId: room.agentId,
      kind: "skill",
      body,
      messageIds: [message.id],
    });
    await approve(db, room.accountId, saved.id, skillsRoot);
    expect(await readFile(join(skillsRoot, "letters", "SKILL.md"), "utf8")).toBe(body);
    expect(await promptVersion(room.agentId)).toBe(2);
    await rm(skillsRoot, { recursive: true, force: true });
  });

  it("approves over HTTP for this account only, and a live turn does not edit the prompt", async () => {
    const room = await openRoom("Http");
    const message = await saveMessage(room, "Add a standing line.");
    const saved = await propose(db, room.accountId, {
      agentId: room.agentId,
      kind: "prompt",
      body: "Sign every letter.",
      messageIds: [message.id],
    });
    const server = await startServer(db, 0);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const outsider = await createAccount(db, { name: "Outsider" });
    const blocked = await fetch(`${baseUrl}/proposals/${saved.id}/approve?accountId=${outsider.id}`, { method: "POST" });
    expect(blocked.status).toBe(404);
    expect(await promptVersion(room.agentId)).toBe(1);

    const approved = await fetch(`${baseUrl}/proposals/${saved.id}/approve?accountId=${room.accountId}`, { method: "POST" });
    expect(approved.status).toBe(200);
    expect(await promptVersion(room.agentId)).toBe(2);
    const [agent] = await db.select().from(agents).where(eq(agents.id, room.agentId));
    expect(agent?.description.endsWith("Sign every letter.")).toBe(true);
    await new Promise<void>((resolve, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolve()));
    });

    const before = await promptVersion(room.agentId);
    const [conversation] = await db
      .insert(conversations)
      .values({ accountId: room.accountId, kind: "direct", ownerAgentId: room.agentId, title: "live" })
      .returning();
    await runTurn(db, room.accountId, conversation!.id, "hello", async () => ({
      text: "noted",
      proposal: { kind: "prompt" as const, body: "Do not apply this yet.", messageIds: [message.id] },
    }));
    const [afterTurn] = await db.select().from(agents).where(eq(agents.id, room.agentId));
    expect(afterTurn?.promptVersion).toBe(before);
    expect(afterTurn?.description.includes("Do not apply this yet.")).toBe(false);
    const pending = await db.select().from(proposals).where(eq(proposals.agentId, room.agentId));
    expect(pending.some((row) => row.body === "Do not apply this yet." && row.status === "pending")).toBe(true);
  });
});

async function openRoom(name: string) {
  const account = await createAccount(db, { name });
  const owner = await createAgent(db, account.id, {
    name: "Ada",
    label: "Ada",
    description: "Keep the ledger.",
    provider: "openai",
    modelId: "gpt-5",
  });
  return { accountId: account.id, agentId: owner.id };
}

async function saveMessage(room: { accountId: string; agentId: string }, body: string) {
  const [conversation] = await db
    .insert(conversations)
    .values({ accountId: room.accountId, kind: "direct", ownerAgentId: room.agentId, title: "note" })
    .returning();
  const [message] = await db
    .insert(messages)
    .values({ accountId: room.accountId, conversationId: conversation!.id, agentId: null, body })
    .returning();
  return message!;
}

async function promptVersion(agentId: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  return agent?.promptVersion;
}
