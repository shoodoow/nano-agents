/**
 * Per-turn compaction entry point.
 * Why: after a turn settles, fold any messages that just aged out of the
 * recent window into cited summary items and durable facts, using the room
 * owner's model. When facts landed the pinned profile is rewritten, and a
 * finished month or year is condensed into a digest. Best-effort: a missing
 * key, a model error, or nothing to do all resolve to a no-op so a turn is
 * never blocked or failed by compaction.
 * DB: reads agents/conversations/provider_keys, writes summary_items, memories.
 */
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, conversations } from "../db/schema.js";
import { keyFor } from "../keys/keys.js";
import { FOLD_BATCH, RECENT_WINDOW } from "../turn/constants.js";
import { foldAged } from "./compaction.js";
import { embedSummaryBacklog } from "./recall.js";
import { refreshProfile, rollUp } from "./rollup.js";
import { llmFoldSummarizer, llmWriter } from "./summarize-fold.js";

type Db = ReturnType<typeof getDb>;

export async function compactConversation(db: Db, accountId: string, conversationId: string): Promise<void> {
  try {
    const [room] = await db
      .select({ ownerAgentId: conversations.ownerAgentId })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
    if (!room) return;
    const [owner] = await db
      .select({ provider: agents.provider, modelId: agents.modelId })
      .from(agents)
      .where(and(eq(agents.id, room.ownerAgentId), eq(agents.accountId, accountId)));
    if (!owner) return;
    const credential = await keyFor(db, accountId, owner.provider).catch(() => null);
    if (!credential) return;
    const deps = {
      provider: owner.provider,
      modelId: owner.modelId,
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl,
    };
    const folded = await foldAged(db, accountId, conversationId, RECENT_WINDOW, FOLD_BATCH, llmFoldSummarizer(deps));
    if (folded.length === 0 && !folded.factsSaved) return;
    const write = llmWriter(deps);
    if (folded.factsSaved && folded.lastMessageId) {
      await refreshProfile(db, accountId, write, folded.lastMessageId).catch(() => {});
    }
    // A fold is the only moment new summary lines appear, so it is the only
    // moment a period can become due. One digest per level per turn.
    await rollUp(db, accountId, conversationId, write, 1).catch(() => null);
    await rollUp(db, accountId, conversationId, write, 2).catch(() => null);
    // Backfill embeddings for anything new so semantic recall can reach it later.
    await embedSummaryBacklog(db, accountId, conversationId).catch(() => {});
  } catch {
    // Compaction is best-effort; never let it break a turn.
  }
}
