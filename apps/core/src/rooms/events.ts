import { and, asc, eq, gt, lt } from "drizzle-orm";
import type { Store } from "../db/client.js";
import { events } from "../db/schema.js";
import type { TurnEvent } from "./send-message.js";

export type EventType = "message" | "reaction" | "run" | "error" | "notify";

/**
 * Appends one turn event to the durable log.
 * Why: in-memory fanout loses everything on restart or client timeout; the
 * events table (short tx right after its source row) makes every bubble
 * replayable by cursor. Same payload shape on replay and live so a future
 * Redis Streams layer slots in without client changes.
 * Input: store, account/conversation ids, optional run id, typed payload.
 * Output: the saved event row (id is the SSE cursor).
 */
export async function appendEvent(
  store: Store,
  input: { accountId: string; conversationId: string; runId?: string | null; event: TurnEvent },
) {
  const [row] = await store
    .insert(events)
    .values({
      accountId: input.accountId,
      conversationId: input.conversationId,
      runId: input.runId ?? null,
      type: input.event.type,
      payload: input.event as Record<string, unknown>,
    })
    .returning();
  if (!row) throw new Error("Event insert returned no row.");
  return row;
}

/**
 * Lists events after a cursor for SSE replay.
 * Why: a client reconnecting with its last-seen event id receives exactly the
 * missed tail, then attaches to live fanout. Bounded (default 200) so a
 * day-away phone does one cheap query, not a full thread scan.
 * Input: store, account/conversation ids, afterId cursor, limit.
 * Output: events in id order.
 */
export async function listEventsSince(
  store: Store,
  accountId: string,
  conversationId: string,
  afterId: number,
  limit = 200,
) {
  return store
    .select()
    .from(events)
    .where(and(eq(events.accountId, accountId), eq(events.conversationId, conversationId), gt(events.id, afterId)))
    .orderBy(asc(events.id))
    .limit(Math.min(Math.max(limit, 1), 500));
}

/**
 * Deletes events older than the retention window.
 * Why: the log is a resume buffer, not an archive — messages remain the source
 * of truth. Called by the scheduler tick so the table stays small.
 * Input: store, retention days. Output: nothing.
 */
export async function pruneEvents(store: Store, retentionDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  await store.delete(events).where(lt(events.createdAt, cutoff));
}
