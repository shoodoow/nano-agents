import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proposalSchema } from "@nano-agents/shared";
import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, proposals } from "../db/schema.js";
import { remember } from "../memory/memory.js";
import { accountSkillRoot } from "./skills.js";

type Database = Pick<ReturnType<typeof getDb>, "insert" | "select" | "update">;

/**
 * Stores a lesson for a person to accept or refuse.
 * Input: database, account id, and the agent, kind, suggested text, and message ids.
 * Output: the pending proposal. A proposal with no message id is refused.
 */
export async function propose(db: Database, accountId: string, input: unknown) {
  const data = proposalSchema.parse(input);
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, data.agentId), eq(agents.accountId, accountId)));
  if (!agent) {
    throw new Error("Agent not found.");
  }
  const [row] = await db
    .insert(proposals)
    .values({
      accountId,
      agentId: data.agentId,
      kind: data.kind,
      body: data.body,
      messageIds: data.messageIds,
      status: "pending",
    })
    .returning();
  if (!row) {
    throw new Error("The proposal insert returned no row.");
  }
  return row;
}

/**
 * Lists pending proposals for one account.
 * Input: database and the account id.
 * Output: proposals still waiting for a person. Other accounts are not included.
 */
export async function listProposals(db: Database, accountId: string) {
  return db
    .select()
    .from(proposals)
    .where(and(eq(proposals.accountId, accountId), eq(proposals.status, "pending")));
}

/**
 * Applies one pending proposal and bumps that agent's prompt version.
 * Input: database, account id, proposal id, and the skills directory used when the kind is skill.
 * Output: the approved proposal, or null when this account does not own it.
 */
export async function approve(db: Database, accountId: string, proposalId: string, skillsRoot?: string) {
  const [proposal] = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), eq(proposals.accountId, accountId), eq(proposals.status, "pending")));
  if (!proposal) {
    return null;
  }
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, proposal.agentId), eq(agents.accountId, accountId)));
  if (!agent) {
    return null;
  }
  if (proposal.kind === "skill") {
    writeSkill(skillsRoot, accountId, proposal.body);
  }
  if (proposal.kind === "prompt") {
    await db
      .update(agents)
      .set({ jobDescription: `${agent.jobDescription}\n\n${proposal.body}` })
      .where(and(eq(agents.id, agent.id), eq(agents.accountId, accountId)));
  }
  if (proposal.kind === "memory") {
    await remember(db, accountId, {
      scope: "agent",
      agentId: agent.id,
      body: proposal.body,
      messageId: proposal.messageIds[0],
    });
  }
  await db
    .update(agents)
    .set({ promptVersion: sql`${agents.promptVersion} + 1` })
    .where(and(eq(agents.id, agent.id), eq(agents.accountId, accountId)));
  const [updated] = await db
    .update(proposals)
    .set({ status: "approved" })
    .where(eq(proposals.id, proposal.id))
    .returning();
  return updated ?? null;
}

/**
 * Refuses one pending proposal.
 * Input: database, account id, and proposal id.
 * Output: the rejected proposal, or null when this account does not own it. The prompt version and skill files stay as they were.
 */
export async function reject(db: Database, accountId: string, proposalId: string) {
  const [updated] = await db
    .update(proposals)
    .set({ status: "rejected" })
    .where(and(eq(proposals.id, proposalId), eq(proposals.accountId, accountId), eq(proposals.status, "pending")))
    .returning();
  return updated ?? null;
}

function writeSkill(skillsRoot: string | undefined, accountId: string, body: string) {
  if (!skillsRoot) {
    throw new Error("A skill proposal needs a skills directory.");
  }
  const name = skillName(body);
  if (!name) {
    throw new Error("A skill proposal needs a name.");
  }
  // Account folder, not the shared root: another tenant must not receive this file.
  const directory = join(accountSkillRoot(skillsRoot, accountId), name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), body);
}

function skillName(body: string): string | undefined {
  const lines = body.split("\n");
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") {
      return undefined;
    }
    const match = line.match(/^name:\s*([A-Za-z0-9-]+)\s*$/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}
