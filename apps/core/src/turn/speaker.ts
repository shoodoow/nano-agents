/**
 * One agent speaks in a turn (context load → model loop → mention chain).
 * DB: reads messages/summary; writes messages via tools or stub path.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { accounts, agents, delegations, jobs, messages, routines, summaryItems } from "../db/schema.js";
import { buildContext, type PersonContext } from "../memory/context.js";
import { isNarrationStall, STALL_MESSAGE } from "./narration-stall.js";
import { memoriesFor } from "../memory/memory.js";
import { recallRelevant } from "../memory/recall.js";
import { createProfile } from "../linux/linux.js";
import { RECENT_WINDOW, SUMMARY_WINDOW } from "./constants.js";
import { propose } from "../skills/proposals.js";
import { skillCatalogForAgent } from "../skills/agent-skills.js";
import type { TurnEvent } from "../rooms/send-message.js";
import { runAgentLoop } from "./agent-loop.js";
import { mentionedAgents } from "./mentions.js";
import { toModelMessages, type ReplyParent } from "./prompt-media.js";
import type { GenerateResult, TurnInput } from "./types.js";
import { tailSlice, unwrapGenerateResult } from "./util.js";
import { createTraceSession } from "./trace/plugins.js";
import { randomUUID } from "node:crypto";

type Db = ReturnType<typeof getDb>;

export async function speakOnce(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    agentId: string;
    memberRows: { id: string; name: string; label?: string; role?: string }[];
    room: { title: string; kind: string };
    skillsRoot?: string;
    generate?: (input: TurnInput) => Promise<GenerateResult>;
    nextTime: () => Date;
    runId: string;
    emit: (event: TurnEvent) => Promise<void>;
    saved: (typeof messages.$inferSelect)[];
    queue: (string | undefined)[];
    spoken: Set<string>;
    cue?: string;
    /**
     * Per-run usage accumulator (mutated). Survives years-long threads:
     * each speaker adds its harness usage; orchestrator persists the sum.
     * Stub-generate test turns contribute nothing.
     */
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; steps: number };
  },
): Promise<void> {
  const { accountId, conversationId, agentId, memberRows, room, skillsRoot, generate, nextTime, runId, emit, saved, queue, spoken, cue, usage } =
    input;
  let [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  if (!agent) throw new Error("Agent not found");
  if (!agent.linuxProfile) {
    try {
      await createProfile(db, accountId, agentId);
      const [refreshed] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
      if (refreshed) agent = refreshed;
    } catch {
      // Computer unavailable; chat continues.
    }
  }
  // Recent window only: older turns live in folded summary items, not the prompt,
  // so a years-long thread stays inside the context window and stays sharp.
  const recent = (
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)))
      .orderBy(desc(messages.createdAt))
      .limit(RECENT_WINDOW)
  ).reverse();
  const summary = (
    await db
      .select()
      .from(summaryItems)
      .where(and(eq(summaryItems.conversationId, conversationId), eq(summaryItems.accountId, accountId)))
      .orderBy(desc(summaryItems.createdAt))
      .limit(SUMMARY_WINDOW)
  ).reverse();
  const facts = await memoriesFor(db, accountId, agentId);
  // Pull back the slice of older context most relevant to the latest message.
  // No-ops (returns []) unless an embedding key is configured.
  const lastUserMessage = [...recent].reverse().find((message) => !message.agentId)?.body ?? cue ?? "";
  const recall = await recallRelevant(db, {
    accountId,
    agentId,
    conversationId,
    query: lastUserMessage,
  }).catch(() => [] as string[]);
  const catalog = (
    await skillCatalogForAgent({
      skillsRoot,
      accountId,
      linuxProfile: agent.linuxProfile,
    })
  )
    .map((skill) => skill.name)
    .join("\n");
  // Query active background workers running for this parent agent in this room.
  // This gives the dispatcher full visibility over background tasks so it:
  // 1) Remains available to converse with the user while tasks run.
  // 2) Knows what's in-flight to report status.
  // 3) Can redirect or stop active workers rather than spawning duplicates.
  const activeWorkers = await db
    .select({
      childAgentId: delegations.childAgentId,
      label: agents.label,
      task: delegations.task,
      progress: delegations.progress,
      createdAt: delegations.createdAt,
    })
    .from(delegations)
    .innerJoin(agents, eq(agents.id, delegations.childAgentId))
    .where(
      and(
        eq(delegations.accountId, accountId),
        eq(delegations.conversationId, conversationId),
        eq(delegations.parentAgentId, agentId),
        eq(delegations.status, "running"),
      ),
    )
    .orderBy(desc(delegations.createdAt))
    .limit(5);
  const recentWorkers = await db
    .select({
      title: delegations.task,
      outcome: delegations.result,
      status: delegations.status,
      createdAt: delegations.createdAt,
    })
    .from(delegations)
    .where(
      and(
        eq(delegations.accountId, accountId),
        eq(delegations.conversationId, conversationId),
        eq(delegations.parentAgentId, agentId),
        inArray(delegations.status, ["done", "failed"]),
      ),
    )
    .orderBy(desc(delegations.createdAt))
    .limit(5);
  const recentRoutines = await db
    .select({
      title: routines.title,
      outcome: jobs.result,
      status: jobs.status,
      createdAt: jobs.runAt,
    })
    .from(jobs)
    .innerJoin(routines, eq(jobs.routineId, routines.id))
    .where(
      and(
        eq(jobs.accountId, accountId),
        eq(routines.agentId, agentId),
        inArray(jobs.status, ["done", "failed"]),
      ),
    )
    .orderBy(desc(jobs.runAt))
    .limit(5);
  const seenTasks = new Set<string>();
  const workHistory = [
    ...recentWorkers.map((item) => ({ ...item, kind: "worker" as const, outcome: item.outcome ?? "" })),
    ...recentRoutines.map((item) => ({ ...item, kind: "routine" as const, outcome: item.outcome ?? "" })),
  ]
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .filter((item) => {
      const head = item.title.replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase();
      if (seenTasks.has(head)) return false;
      seenTasks.add(head);
      return true;
    })
    .slice(0, 3);

  const context = buildContext({
    accountId,
    agentId: agent.id,
    promptVersion: agent.promptVersion,
    identity: {
      name: agent.name,
      role: agent.role,
      personality: agent.personality,
      job: agent.jobDescription,
    },
    summary: summary.map((item) => ({ key: item.key, body: item.body, messageId: item.messageId })),
    messages: recent.map((message) => ({ body: tailSlice(message.body) })),
    memories: facts.map((fact) => ({ body: fact.body })),
    recall,
    catalog,
    room: {
      title: room.title,
      kind: room.kind,
      members: memberRows.map((member) => member.name),
      selfName: agent.name,
    },
    person: await loadPerson(db, accountId, agentId),
    activeWorkers,
    workHistory,
  });
  const emittedMessages: (typeof messages.$inferSelect)[] = [];
  const replyParents = await loadReplyParents(db, accountId, conversationId, recent);
  const modelMessages = toModelMessages(recent, replyParents);
  if (cue) modelMessages.push({ role: "user", content: cue });
  const useStub = typeof generate === "function";
  const traceSession = createTraceSession({
    traceId: randomUUID(),
    runId,
    accountId,
    conversationId,
    agentId,
    mode: "dispatcher",
    provider: agent.provider,
    modelId: agent.modelId,
  });
  const generateWithStore = useStub
    ? () =>
        (generate as (input: TurnInput) => Promise<GenerateResult>)({
          agentId,
          provider: agent.provider,
          modelId: agent.modelId,
          system: context.prefix,
          prefix: context.prefix,
          tail: context.tail,
          promptCacheKey: context.openai.promptCacheKey,
          accountId,
          linuxProfile: agent.linuxProfile,
          messages: modelMessages,
        })
    : () =>
        runAgentLoop(db, db, {
          agentId,
          provider: agent.provider,
          modelId: agent.modelId,
          system: context.prefix,
          prefix: context.prefix,
          tail: context.tail,
          promptCacheKey: context.openai.promptCacheKey,
          accountId,
          linuxProfile: agent.linuxProfile,
          conversationId,
          runId,
          skillsRoot,
          nextTime,
          emittedMessages,
          emit,
          messages: modelMessages,
          generate,
        });
  let result: ReturnType<typeof unwrapGenerateResult>;
  try {
    result = unwrapGenerateResult(await generateWithStore());
    if (usage && result.usage) {
      usage.input += result.usage.inputTokens ?? 0;
      usage.output += result.usage.outputTokens ?? 0;
      usage.cacheRead += result.usage.cacheReadTokens ?? 0;
      usage.cacheWrite += result.usage.cacheWriteTokens ?? 0;
      usage.reasoning += result.usage.reasoningTokens ?? 0;
      usage.steps += result.usage.steps ?? 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    void traceSession.emit({ type: "run.error", phase: "model", message: message.slice(0, 500) });
    console.log('error', message);
    result = {
      text: message.startsWith("Add an API key")
        ? message
        : "The model provider failed. Check the provider key, model id, and endpoint.",
      cacheReadTokens: null,
    };
  }
  if (emittedMessages.length > 0) {
    for (const row of emittedMessages) {
      saved.push(row);
    }
    if (result.proposal) {
      await propose(db, accountId, {
        agentId,
        kind: result.proposal.kind,
        body: result.proposal.body,
        messageIds: result.proposal.messageIds,
      });
    }
    const chainSource = emittedMessages
      .filter((m) => !m.viaAgentId)
      .map((m) => m.body)
      .join("\n");
    for (const next of mentionedAgents(chainSource, memberRows, true)) {
      if (!spoken.has(next)) queue.push(next);
    }
    return;
  }
  const text = result.text.trim();
  const bodyText = isNarrationStall(text)
    ? STALL_MESSAGE
    : text || "The tools finished, but the model sent no message.";
  const [wrapped] = await db
    .insert(messages)
    .values({
      accountId,
      conversationId,
      agentId,
      runId,
      body: bodyText,
      kind: "rich",
      payload: [{ kind: "text", markdown: bodyText }],
      cacheReadTokens: result.cacheReadTokens,
      createdAt: nextTime(),
    })
    .returning();
  saved.push(wrapped!);
  await emit({ type: "message", message: wrapped! });
  if (result.proposal) {
    await propose(db, accountId, {
      agentId,
      kind: result.proposal.kind,
      body: result.proposal.body,
      messageIds: result.proposal.messageIds,
    });
  }
  for (const next of mentionedAgents(bodyText, memberRows, true)) {
    if (!spoken.has(next)) queue.push(next);
  }
}

/**
 * Loads who the person is for this turn's tail.
 * Why: the room roster is agents; the human has to be named separately.
 * Team/groups are account-level so a private chat sees them without extra
 * list_team/list_groups calls. Generic: roster with copy-pasteable UUIDs.
 * Input: account id and the speaking agent. Output: name, zone, now, team, groups.
 */
async function loadPerson(db: Db, accountId: string, agentId: string): Promise<PersonContext> {
  const [account] = await db
    .select({ name: accounts.name, timezone: accounts.timezone })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const { listTeam } = await import("../rooms/subagents.js");
  const { listGroupRoomsForAgent } = await import("../rooms/rooms.js");
  const [team, groups] = await Promise.all([
    listTeam(db, accountId, agentId).catch(() => []),
    listGroupRoomsForAgent(db, accountId, agentId).catch(() => []),
  ]);
  return {
    name: account?.name ?? "the person",
    timezone: account?.timezone ?? "",
    now: new Date(),
    teammates: team.map((member) => ({
      id: member.id,
      label: member.label?.trim() || member.name,
      role: member.role?.trim() || "teammate",
      mention: member.name,
    })),
    groups: groups.map((group) => ({ id: group.conversationId, title: group.title, owned: group.owned })),
  };
}

/**
 * Loads reply parents missing from the recent window.
 * Why: a short reply like "yes" needs the quoted parent even if that parent scrolled out of recent.
 */
async function loadReplyParents(
  db: ReturnType<typeof getDb>,
  accountId: string,
  conversationId: string,
  recent: { id?: string; replyTo?: string | null }[],
): Promise<Map<string, ReplyParent>> {
  const known = new Set(recent.map((row) => row.id).filter((id): id is string => Boolean(id)));
  const missing = [
    ...new Set(
      recent
        .map((row) => row.replyTo)
        .filter((id): id is string => typeof id === "string" && id.length > 0 && !known.has(id)),
    ),
  ];
  const parents = new Map<string, ReplyParent>();
  if (missing.length === 0) return parents;
  const rows = await db
    .select({ id: messages.id, body: messages.body, agentId: messages.agentId })
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        eq(messages.conversationId, conversationId),
        inArray(messages.id, missing),
      ),
    );
  for (const row of rows) parents.set(row.id, { body: row.body, agentId: row.agentId });
  return parents;
}
