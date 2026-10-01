/**
 * Rolling-window compaction (keeps a years-long thread sharp and inside the
 * context window). The newest RECENT_WINDOW messages ride in the prompt
 * verbatim; everything older is folded, once, into cited summary items by an
 * LLM. A watermark (the newest message a summary item cites) guarantees each
 * message is folded exactly once, so folds never re-summarize or duplicate.
 * DB: reads messages/summary_items, writes summary_items via mergeSummary.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { messages, summaryItems } from "../db/schema.js";
import { mergeSummary } from "./summary.js";

type Db = Pick<ReturnType<typeof getDb>, "select" | "insert">;

type SliceMessage = { id: string; agentId: string | null; body: string };

/** A summarizer turns an aged-out slice into cited summary items. */
export type FoldSummarizer = (slice: SliceMessage[]) => Promise<{ key: string; body: string; messageId: string }[]>;

/**
 * Folds messages that have just aged out of the recent window.
 * Input: db, ids, how many recent messages to keep verbatim, the minimum batch
 * before folding, and a summarizer. Output: the summary items written (empty
 * when there is nothing new to fold). The original messages are never deleted.
 */
export async function foldAged(
  db: Db,
  accountId: string,
  conversationId: string,
  keepRecent: number,
  minBatch: number,
  summarize: FoldSummarizer,
): Promise<{ key: string; body: string }[]> {
  const history = await db
    .select({ id: messages.id, agentId: messages.agentId, body: messages.body })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.conversationId, conversationId)))
    .orderBy(asc(messages.createdAt));
  if (history.length <= keepRecent) {
    return [];
  }
  const agedOut = history.slice(0, history.length - keepRecent);
  const watermark = await foldWatermarkIndex(db, accountId, conversationId, agedOut);
  const newlyAged = agedOut.slice(watermark);
  if (newlyAged.length < minBatch) {
    return [];
  }
  const items = await summarize(newlyAged);
  const valid = items.filter((item) => item.body.trim().length > 0 && item.messageId);
  if (valid.length === 0) {
    return [];
  }
  const saved = await mergeSummary(db, accountId, conversationId, valid);
  return saved.map((item) => ({ key: item.key, body: item.body }));
}

/**
 * Returns how many of the aged-out messages are already folded.
 * Why: a summary item cites the last message of the slice it folded, so the
 * highest cited position in the aged-out list is the fold frontier. Anything
 * after it is new and still needs folding.
 */
async function foldWatermarkIndex(
  db: Db,
  accountId: string,
  conversationId: string,
  agedOut: SliceMessage[],
): Promise<number> {
  const ids = agedOut.map((message) => message.id);
  if (ids.length === 0) {
    return 0;
  }
  const cited = await db
    .select({ messageId: summaryItems.messageId })
    .from(summaryItems)
    .where(
      and(
        eq(summaryItems.accountId, accountId),
        eq(summaryItems.conversationId, conversationId),
        inArray(summaryItems.messageId, ids),
      ),
    );
  if (cited.length === 0) {
    return 0;
  }
  const citedSet = new Set(cited.map((row) => row.messageId));
  let frontier = 0;
  for (let i = 0; i < agedOut.length; i++) {
    if (citedSet.has(agedOut[i]!.id)) {
      frontier = i + 1;
    }
  }
  return frontier;
}
