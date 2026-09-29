import { delegateSchema, subagentCreateSchema } from "@nano-agents/shared";
import { and, count, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, conversations, delegations, members } from "../db/schema.js";
import { RoomCapacityError } from "./rooms.js";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const MAX_CHILDREN_PER_PARENT = 10;
export const MAX_TEAM_DEPTH = 2;
export const MAX_ROOM_MEMBERS = 20;

/**
 * Returns how deep an agent sits in the team tree (0 = top-level hire).
 * Why: unbounded spawn chains fork-bomb the room and blow the prompt budget.
 * Input: tx, account id, agent id. Output: depth number.
 */
export async function teamDepth(tx: Tx, accountId: string, agentId: string): Promise<number> {
  let depth = 0;
  let current: string | null = agentId;
  while (current) {
    const [row] = await tx
      .select({ parentId: agents.parentId })
      .from(agents)
      .where(and(eq(agents.id, current), eq(agents.accountId, accountId)));
    if (!row?.parentId) break;
    depth += 1;
    current = row.parentId;
    if (depth > MAX_TEAM_DEPTH) break;
  }
  return depth;
}

/**
 * Creates a child specialist owned by the calling agent.
 * Why: Grok chief-of-staff pattern — coordinator hires specialists instead of
 * forcing the user to hire+mention each one. Child inherits provider/model
 * unless overridden, joins the same room so handoffs stay visible.
 * Input: tx, account/room/caller ids, label/description/provider/modelId.
 * Output: the child agent + membership row. Throws on caps or room-full.
 */
export async function hireSubagent(
  tx: Tx,
  input: { accountId: string; conversationId: string; parentAgentId: string; teamId?: string } & {
    label: string;
    description: string;
    provider?: string;
    modelId?: string;
  },
) {
  const data = subagentCreateSchema.parse({
    label: input.label,
    description: input.description,
    provider: input.provider,
    modelId: input.modelId,
  });
  const [parent] = await tx
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.parentAgentId), eq(agents.accountId, input.accountId)));
  if (!parent) throw new Error("Parent agent not found.");
  const depth = await teamDepth(tx, input.accountId, input.parentAgentId);
  if (depth >= MAX_TEAM_DEPTH) throw new Error("Subagents cannot hire their own subagents beyond depth 2.");
  const [childCount] = await tx
    .select({ value: count() })
    .from(agents)
    .where(and(eq(agents.parentId, input.parentAgentId), eq(agents.accountId, input.accountId)));
  if ((childCount?.value ?? 0) >= MAX_CHILDREN_PER_PARENT) {
    throw new Error("This agent already has 10 subagents.");
  }
  const [room] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)));
  if (!room) throw new Error("Room not found.");
  const existing = await tx
    .select({ agentId: members.agentId })
    .from(members)
    .where(and(eq(members.conversationId, input.conversationId), eq(members.accountId, input.accountId)));
  if (existing.length >= MAX_ROOM_MEMBERS) throw new RoomCapacityError();

  const baseName = data.label.trim().replace(/\s+/g, "-").slice(0, 60) || "subagent";
  const [child] = await tx
    .insert(agents)
    .values({
      accountId: input.accountId,
      name: `${baseName}-${Math.random().toString(36).slice(2, 6)}`,
      label: data.label,
      description: data.description,
      provider: data.provider ?? parent.provider,
      modelId: data.modelId ?? parent.modelId,
      parentId: input.parentAgentId,
      teamId: input.teamId ?? parent.teamId ?? parent.id,
    })
    .returning();
  if (!child) throw new Error("Subagent insert returned no row.");
  await tx.insert(members).values({ conversationId: input.conversationId, accountId: input.accountId, agentId: child.id });
  return child;
}

/**
 * Records a delegation from parent to an existing team agent.
 * Why: attribution table lets the UI show "via @chief" and lets audits trace
 * who asked for what; status flips to done/failed by the turn runner.
 * Input: tx, account/room/parent ids, child agentId, task text.
 * Output: delegation row. Throws when child is outside account or self.
 */
export async function recordDelegation(
  tx: Tx,
  input: { accountId: string; conversationId: string; parentAgentId: string; agentId: string; task: string },
) {
  const data = delegateSchema.parse({ agentId: input.agentId, task: input.task });
  if (data.agentId === input.parentAgentId) throw new Error("An agent cannot delegate to itself.");
  const [child] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, data.agentId), eq(agents.accountId, input.accountId)));
  if (!child) throw new Error("Delegate target is not on this account.");
  const [membership] = await tx
    .select({ agentId: members.agentId })
    .from(members)
    .where(
      and(
        eq(members.conversationId, input.conversationId),
        eq(members.accountId, input.accountId),
        eq(members.agentId, data.agentId),
      ),
    );
  if (!membership) throw new Error("Delegate target is not in this room.");
  const [row] = await tx
    .insert(delegations)
    .values({
      accountId: input.accountId,
      parentAgentId: input.parentAgentId,
      childAgentId: data.agentId,
      conversationId: input.conversationId,
      task: data.task,
      status: "running",
    })
    .returning();
  if (!row) throw new Error("Delegation insert returned no row.");
  return row;
}

/**
 * Lists agents sharing the caller's team (same teamId or direct children).
 * Why: the model needs a small roster to choose delegates without dumping
 * the whole account roster into the prompt.
 * Input: tx, account id, agent id. Output: team agents (id, name, label).
 */
export async function listTeam(tx: Tx, accountId: string, agentId: string) {
  const [self] = await tx
    .select({ teamId: agents.teamId, id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  if (!self) return [];
  if (!self.teamId) {
    return tx
      .select({ id: agents.id, name: agents.name, label: agents.label })
      .from(agents)
      .where(and(eq(agents.parentId, agentId), eq(agents.accountId, accountId)));
  }
  return tx
    .select({ id: agents.id, name: agents.name, label: agents.label })
    .from(agents)
    .where(and(eq(agents.teamId, self.teamId), eq(agents.accountId, accountId)));
}
