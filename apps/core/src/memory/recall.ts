/**
 * Semantic recall over durable memory (pgvector).
 * Why: a years-long thread can accumulate thousands of folded summary items and
 * facts — far more than fits in a prompt. Instead of dumping them all, embed
 * each once and pull back only the few most relevant to what's happening now.
 * Everything degrades gracefully: with no embedding-capable provider key, embeds
 * are skipped (columns stay null) and recall returns nothing, so chat still runs.
 * DB: reads/writes summary_items.embedding and memories.embedding.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { embed, embedMany, type EmbeddingModel } from "ai";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { members, memories, summaryItems } from "../db/schema.js";
import { keyFor } from "../keys/keys.js";
import { isOpenAiCompatibleProvider } from "../model/get-model.js";
import { RECALL_K } from "../turn/constants.js";

type Db = ReturnType<typeof getDb>;

const EMBED_MODEL = "text-embedding-3-small";
const BACKLOG_LIMIT = 64;
/** Cosine distance ceiling (0 = identical, 2 = opposite). Drops weak matches. */
const MAX_DISTANCE = 0.6;

/**
 * Resolves an embedding model from the account's keys, or null when none can
 * embed. Requires a real OpenAI key (official API or an OpenAI-compatible base
 * that actually serves embeddings). This stays dormant for accounts that only
 * configured a chat-only provider (e.g. a local deepseek endpoint), so recall
 * never fires a failing embedding call every turn — it simply no-ops until an
 * embedding key is added.
 */
async function accountEmbedder(db: Db, accountId: string): Promise<EmbeddingModel | null> {
  const credential = await keyFor(db, accountId, "openai").catch(() => null);
  if (!credential || !isOpenAiCompatibleProvider("openai")) return null;
  const key = credential.apiKey.trim();
  if (!key) return null;
  const base = credential.baseUrl?.trim();
  return createOpenAI({ apiKey: key, ...(base ? { baseURL: base } : {}) }).textEmbeddingModel(EMBED_MODEL);
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Embeds any summary items (for one room) and account facts that are missing a
 * vector. Called after a fold so new durable memory becomes recall-reachable.
 */
export async function embedSummaryBacklog(db: Db, accountId: string, conversationId: string): Promise<void> {
  const model = await accountEmbedder(db, accountId);
  if (!model) return;
  const pendingSummaries = await db
    .select({ id: summaryItems.id, body: summaryItems.body })
    .from(summaryItems)
    .where(and(eq(summaryItems.accountId, accountId), eq(summaryItems.conversationId, conversationId), isNull(summaryItems.embedding)))
    .limit(BACKLOG_LIMIT);
  const pendingFacts = await db
    .select({ id: memories.id, body: memories.body })
    .from(memories)
    .where(and(eq(memories.accountId, accountId), isNull(memories.embedding)))
    .limit(BACKLOG_LIMIT);
  await embedRows(db, model, summaryItems, pendingSummaries);
  await embedRows(db, model, memories, pendingFacts);
}

async function embedRows(
  db: Db,
  model: EmbeddingModel,
  table: typeof summaryItems | typeof memories,
  rows: { id: string; body: string }[],
): Promise<void> {
  if (rows.length === 0) return;
  const { embeddings } = await embedMany({ model, values: rows.map((row) => row.body) });
  for (let i = 0; i < rows.length; i++) {
    const vector = embeddings[i];
    if (!vector) continue;
    await db.update(table).set({ embedding: vector }).where(eq(table.id, rows[i]!.id)).catch(() => {});
  }
}

/**
 * Pulls the durable memory most relevant to the current moment.
 * Input: db, ids, the query text (usually the latest user message), and k.
 * Output: distinct bodies (folded summaries from rooms this employee belongs
 * to + this agent's facts), nearest first, or [] when embeddings are unavailable.
 */
export async function recallRelevant(
  db: Db,
  input: { accountId: string; agentId: string; conversationId: string; query: string; k?: number },
): Promise<string[]> {
  const query = input.query.trim();
  if (!query) return [];
  const model = await accountEmbedder(db, input.accountId);
  if (!model) return [];
  const { embedding } = await embed({ model, value: query }).catch(() => ({ embedding: null as number[] | null }));
  if (!embedding) return [];
  const literal = toVectorLiteral(embedding);
  const k = input.k ?? RECALL_K;
  const summaryHits = await db
    .select({ body: summaryItems.body, distance: sql<number>`${summaryItems.embedding} <=> ${literal}::vector` })
    .from(summaryItems)
    .innerJoin(
      members,
      and(
        eq(members.conversationId, summaryItems.conversationId),
        eq(members.accountId, summaryItems.accountId),
        eq(members.agentId, input.agentId),
      ),
    )
    .where(
      and(
        eq(summaryItems.accountId, input.accountId),
        sql`${summaryItems.embedding} is not null`,
      ),
    )
    .orderBy(sql`${summaryItems.embedding} <=> ${literal}::vector`)
    .limit(k);
  const factHits = await db
    .select({ body: memories.body, distance: sql<number>`${memories.embedding} <=> ${literal}::vector` })
    .from(memories)
    .where(
      and(
        eq(memories.accountId, input.accountId),
        sql`(${memories.scope} = 'user' or (${memories.scope} = 'agent' and ${memories.agentId} = ${input.agentId}))`,
        sql`${memories.embedding} is not null`,
      ),
    )
    .orderBy(sql`${memories.embedding} <=> ${literal}::vector`)
    .limit(k);
  const seen = new Set<string>();
  return [...factHits, ...summaryHits]
    .filter((hit) => hit.distance <= MAX_DISTANCE)
    .sort((left, right) => left.distance - right.distance)
    .map((hit) => hit.body)
    .filter((body) => (seen.has(body) ? false : (seen.add(body), true)))
    .slice(0, k);
}
