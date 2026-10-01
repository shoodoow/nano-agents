/**
 * One agent speaks in a turn (context load → model loop → mention chain).
 * DB: reads messages/summary; writes messages via tools or stub path.
 */
import { and, asc, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, messages, summaryItems } from "../db/schema.js";
import { buildContext } from "../memory/context.js";
import { mergeSummary } from "../memory/summary.js";
import { createProfile } from "../linux/linux.js";
import { propose } from "../skills/proposals.js";
import { skillCatalogForAccount } from "../skills/skills.js";
import type { TurnEvent } from "../rooms/send-message.js";
import { runAgentLoop } from "./agent-loop.js";
import { mentionedAgents } from "./mentions.js";
import { toModelMessages } from "./prompt-media.js";
import type { GenerateResult, TurnInput } from "./types.js";
import { unwrapGenerateResult } from "./util.js";
import { createTraceSession } from "./trace/plugins.js";
import { randomUUID } from "node:crypto";

type Db = ReturnType<typeof getDb>;

export async function speakOnce(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    agentId: string;
    memberRows: { id: string; name: string }[];
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
  },
): Promise<void> {
  const { accountId, conversationId, agentId, memberRows, room, skillsRoot, generate, nextTime, runId, emit, saved, queue, spoken, cue } =
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
  const history = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)))
    .orderBy(asc(messages.createdAt));
  const summary = await db
    .select()
    .from(summaryItems)
    .where(and(eq(summaryItems.conversationId, conversationId), eq(summaryItems.accountId, accountId)));
  const catalog = skillsRoot
    ? skillCatalogForAccount(skillsRoot, accountId)
        .map((skill) => `${skill.name}: ${skill.description}`)
        .join("\n")
    : "";
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
    summary: summary.map((item) => ({ key: item.key, body: item.body })),
    messages: history.map((message) => ({ body: message.body })),
    catalog,
    room: {
      title: room.title,
      kind: room.kind,
      members: memberRows.map((member) => member.name),
      selfName: agent.name,
    },
  });
  const emittedMessages: (typeof messages.$inferSelect)[] = [];
  const modelMessages = toModelMessages(history);
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
      await mergeSummary(db, accountId, conversationId, [{ key: "topics", body: row.body, messageId: row.id }]);
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
  const bodyText = text || "The tools finished, but the model sent no message.";
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
  if (text) {
    await mergeSummary(db, accountId, conversationId, [{ key: "topics", body: text, messageId: wrapped!.id }]);
  }
  if (result.proposal) {
    await propose(db, accountId, {
      agentId,
      kind: result.proposal.kind,
      body: result.proposal.body,
      messageIds: result.proposal.messageIds,
    });
  }
  for (const next of mentionedAgents(result.text, memberRows, true)) {
    if (!spoken.has(next)) queue.push(next);
  }
}
