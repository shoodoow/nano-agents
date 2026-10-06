/**
 * Visible in-room delegate runs (child bubbles via parent).
 * DB: messages with viaAgentId; delegations status updated by delegate executor.
 */
import { and, desc, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, conversations, members, messages } from "../db/schema.js";
import { buildContext, identityBlock } from "../memory/context.js";
import { createProfile } from "../linux/linux.js";
import { mirrorGroupSpeechToOwnerDm, type TurnEvent } from "../rooms/send-message.js";
import { DELEGATION_HISTORY_SLICE } from "./constants.js";
import { runAgentLoop } from "./agent-loop.js";
import type { GenerateResult, TurnInput } from "./types.js";
import { tailSlice, unwrapGenerateResult } from "./util.js";

type Db = ReturnType<typeof getDb>;

export async function runDelegatedTurn(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    runId: string;
    parentAgentId: string;
    childAgentId: string;
    delegationId: string;
    task: string;
    skillsRoot?: string;
    nextTime: () => Date;
    emittedMessages: (typeof messages.$inferSelect)[];
    emit: (event: TurnEvent) => Promise<void>;
    delegationDepth: number;
    generate?: (input: TurnInput) => Promise<GenerateResult>;
  },
): Promise<(typeof messages.$inferSelect)[]> {
  const [child] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.childAgentId), eq(agents.accountId, input.accountId)));
  if (!child) throw new Error("Delegate target is not on this account.");
  const recent = (
    await db
      .select({ agentId: messages.agentId, body: messages.body })
      .from(messages)
      .where(and(eq(messages.conversationId, input.conversationId), eq(messages.accountId, input.accountId)))
      .orderBy(desc(messages.createdAt))
      .limit(DELEGATION_HISTORY_SLICE)
  ).reverse();

  if (input.generate) {
    const identity = identityBlock(child);
    const result = unwrapGenerateResult(
      await input.generate({
        agentId: child.id,
        provider: child.provider,
        modelId: child.modelId,
        system: identity,
        prefix: identity,
        tail: input.task,
        promptCacheKey: `${input.accountId}:${child.id}`,
        accountId: input.accountId,
        linuxProfile: child.linuxProfile,
        messages: [{ role: "user", content: input.task }],
      }),
    );
    const text = result.text.trim() || "The delegated agent sent no message.";
    const [wrapped] = await db
      .insert(messages)
      .values({
        accountId: input.accountId,
        conversationId: input.conversationId,
        agentId: child.id,
        runId: input.runId,
        viaAgentId: input.parentAgentId,
        body: text,
        kind: "rich",
        payload: [{ kind: "text", markdown: text }],
        createdAt: input.nextTime(),
      })
      .returning();
    if (!wrapped) throw new Error("Delegated reply insert returned no row.");
    await mirrorGroupSpeechToOwnerDm(db, wrapped);
    input.emittedMessages.push(wrapped);
    await input.emit({ type: "message", message: wrapped });
    return [wrapped];
  }

  let profile: string | null = child.linuxProfile;
  if (!profile) {
    try {
      profile = await createProfile(db, input.accountId, child.id);
    } catch {
      profile = null;
    }
  }
  const [room] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)));
  if (!room) throw new Error("Room not found");
  const memberRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(members)
    .innerJoin(agents, eq(members.agentId, agents.id))
    .where(and(eq(members.conversationId, input.conversationId), eq(members.accountId, input.accountId)));
  const context = buildContext({
    accountId: input.accountId,
    agentId: child.id,
    promptVersion: child.promptVersion,
    identity: {
      name: child.name,
      role: child.role,
      personality: child.personality,
      job: child.jobDescription,
    },
    summary: [],
    messages: recent.map((row) => ({ body: tailSlice(row.body) })),
    room: {
      title: room.title,
      kind: room.kind,
      members: memberRows.map((member) => member.name),
      selfName: child.name,
    },
  });
  const local: (typeof messages.$inferSelect)[] = [];
  await runAgentLoop(db, db, {
    agentId: child.id,
    provider: child.provider,
    modelId: child.modelId,
    system: context.prefix,
    prefix: context.prefix,
    tail: `${context.tail}\n\nDelegated task (do this, do not fan out mentions): ${input.task}`,
    promptCacheKey: context.openai.promptCacheKey,
    accountId: input.accountId,
    linuxProfile: profile,
    conversationId: input.conversationId,
    runId: input.runId,
    skillsRoot: input.skillsRoot,
    nextTime: input.nextTime,
    emittedMessages: local,
    emit: input.emit,
    viaAgentId: input.parentAgentId,
    delegationDepth: input.delegationDepth,
    messages: [{ role: "user", content: input.task }],
    mode: "dispatcher",
  });
  for (const row of local) input.emittedMessages.push(row);
  return local;
}
