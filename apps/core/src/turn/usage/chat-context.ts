/**
 * Per-chat context + usage payload (plugin-extensible via model-info providers).
 * Why: years-long threads must stay sharp AND visible — the phone shows how
 * much of the window this chat uses and where tokens went, from DB-accurate
 * per-run usage (not trace-log estimates). Context engineering itself is
 * untouched: same RECENT/SUMMARY windows, same fold watermark, same recall.
 * DB: reads agents/conversations/messages/summary_items/runs/delegations.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { getDb } from "../../db/client.js";
import { agents, conversations, delegations, messages, runs, summaryItems } from "../../db/schema.js";
import { buildInstructions } from "../../prompt/build-instructions.js";
import { roomLine } from "../../memory/context.js";
import { RECENT_WINDOW, SUMMARY_WINDOW } from "../constants.js";
import { modelInfoFor } from "./model-info.js";

type Db = ReturnType<typeof getDb>;

/** Rough chars→tokens for display. Labeled estimate: images/tool schemas excluded. */
const CHARS_PER_TOKEN = 4;

export type ChatContextInfo = {
  conversationId: string;
  counts: {
    messages: number;
    summaryItems: number;
    runs: number;
    runsDone: number;
    delegationsRunning: number;
    delegationsDone: number;
  };
  context: {
    prefixChars: number;
    tailChars: number;
    toolCount: number;
    estTokens: number;
    recentWindow: number;
    summaryWindow: number;
  };
  usage: {
    runsTracked: number;
    runsUntracked: number;
    delegationsTracked: number;
    delegationsUntracked: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    lastRuns: {
      id: string;
      status: string;
      inputTokens: number | null;
      outputTokens: number | null;
      modelSteps: number | null;
      createdAt: string;
    }[];
  };
  model: {
    provider: string;
    modelId: string;
    contextWindow: number | null;
    capacitySource: "plugin" | "builtin-estimate" | "unknown";
    /** Share of window one estimated turn occupies, or null when unknown. */
    estTurnShare: number | null;
  };
};

export async function buildChatContextInfo(
  db: Db,
  accountId: string,
  conversationId: string,
  opts?: { toolCount?: number },
): Promise<ChatContextInfo | null> {
  const [room] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  if (!room) return null;
  const [owner] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, room.ownerAgentId), eq(agents.accountId, accountId)));

  const prefixChars = owner
    ? buildInstructions({
        name: owner.name,
        role: owner.role,
        personality: owner.personality,
        job: owner.jobDescription,
      }).length
    : 0;

  const recent = await db
    .select({ body: messages.body })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)))
    .orderBy(desc(messages.createdAt))
    .limit(RECENT_WINDOW);
  const summary = await db
    .select({ key: summaryItems.key, body: summaryItems.body })
    .from(summaryItems)
    .where(and(eq(summaryItems.conversationId, conversationId), eq(summaryItems.accountId, accountId)))
    .orderBy(desc(summaryItems.createdAt))
    .limit(SUMMARY_WINDOW);
  const memberCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)));

  const roomHeader = roomLine({
    title: room.title,
    kind: room.kind,
    members: [],
    selfName: owner?.name ?? "?",
  }).length;
  const tailChars =
    roomHeader + summary.reduce((n, item) => n + item.key.length + item.body.length + 2, 0) +
    recent.reduce((n, row) => n + row.body.length + 1, 0);

  const runRows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.conversationId, conversationId), eq(runs.accountId, accountId)))
    .orderBy(desc(runs.createdAt))
    .limit(50);
  const delegationRows = await db
    .select({
      status: delegations.status,
      inputTokens: delegations.inputTokens,
      outputTokens: delegations.outputTokens,
      cacheReadTokens: delegations.cacheReadTokens,
    })
    .from(delegations)
    .where(and(eq(delegations.conversationId, conversationId), eq(delegations.accountId, accountId)));

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let tracked = 0;
  for (const row of runRows) {
    if (row.inputTokens !== null || row.outputTokens !== null) {
      tracked += 1;
      inputTokens += row.inputTokens ?? 0;
      outputTokens += row.outputTokens ?? 0;
      cacheReadTokens += row.cacheReadTokens ?? 0;
    }
  }
  // Workers bill separately (up to 10 screenshot steps each) — without this
  // the display understates the provider dashboard by an order of magnitude.
  let delegationsTracked = 0;
  for (const row of delegationRows) {
    if (row.inputTokens !== null || row.outputTokens !== null) {
      delegationsTracked += 1;
      inputTokens += row.inputTokens ?? 0;
      outputTokens += row.outputTokens ?? 0;
      cacheReadTokens += row.cacheReadTokens ?? 0;
    }
  }

  const provider = owner?.provider ?? "unknown";
  const modelId = owner?.modelId ?? "unknown";
  const capacity = modelInfoFor(provider, modelId);
  const estTokens = Math.ceil((prefixChars + tailChars) / CHARS_PER_TOKEN);

  return {
    conversationId,
    counts: {
      messages: Number(memberCount[0]?.count ?? recent.length),
      summaryItems: summary.length,
      runs: runRows.length,
      runsDone: runRows.filter((row) => row.status === "done").length,
      delegationsRunning: delegationRows.filter((row) => row.status === "running").length,
      delegationsDone: delegationRows.filter((row) => row.status === "done").length,
    },
    context: {
      prefixChars,
      tailChars,
      toolCount: opts?.toolCount ?? 0,
      estTokens,
      recentWindow: RECENT_WINDOW,
      summaryWindow: SUMMARY_WINDOW,
    },
    usage: {
      runsTracked: tracked,
      runsUntracked: runRows.length - tracked,
      delegationsTracked,
      delegationsUntracked: delegationRows.length - delegationsTracked,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens: inputTokens + outputTokens,
      lastRuns: runRows.slice(0, 10).map((row) => ({
        id: row.id,
        status: row.status,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        modelSteps: row.modelSteps,
        createdAt: row.createdAt.toISOString(),
      })),
    },
    model: {
      provider,
      modelId,
      contextWindow: capacity.contextWindow,
      capacitySource: capacity.source,
      estTurnShare: capacity.contextWindow ? estTokens / capacity.contextWindow : null,
    },
  };
}
