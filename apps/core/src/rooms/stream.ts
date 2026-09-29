import type { Response } from "express";
import type { TurnEvent } from "./send-message.js";

// Live event with resume cursor. Why: replay rows carry their events.id, live
// events get it from appendEvent — the client tracks max cursor and resubmits
// it on reconnect, so restart/timeout loses nothing.
export type StreamEvent = TurnEvent & { cursor?: number; conversationId?: string };

// In-process SSE fanout (single-core v1). Why: background turns must reach
// open phones without polling; keyed by account+room so tenants never cross.
// The events table (Phase 13) is the durable twin: replay covers what fanout
// drops on restart. Scale seam: replace publish() with Redis Streams when a
// second core exists; the event shape stays identical on both paths.
const streamClients = new Map<string, Set<Response>>();

/**
 * Builds the fanout key isolating one room inside one account.
 * Why: one map for all tenants; the key is the only thing stopping account
 * A's bubbles from reaching account B's phone.
 * Input: account and conversation ids. Output: map key string.
 */
export function streamKey(accountId: string, conversationId: string): string {
  return `${accountId}:${conversationId}`;
}

/**
 * Publishes one turn event to every SSE subscriber of that room.
 * Why: live fast path — replay (events table) covers restarts, fanout covers
 * now. Fire-and-forget by design; durability lives in appendEvent, not here.
 * Input: account/conversation ids, event, optional cursor. Output: nothing.
 */
export function publish(
  accountId: string,
  conversationId: string,
  event: StreamEvent,
): void {
  const clients = streamClients.get(streamKey(accountId, conversationId));
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify({ ...event, conversationId })}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // Client went away; cleanup happens on close handler.
    }
  }
}

/**
 * Reports whether anyone is watching a room live right now.
 * Why: the notify delivery policy needs this — open room means in-app banner
 * only, no push. Cheap map lookup, no I/O.
 * Input: account + conversation ids. Output: true when >=1 SSE subscriber.
 */
export function hasWatchers(accountId: string, conversationId: string): boolean {
  return (streamClients.get(streamKey(accountId, conversationId))?.size ?? 0) > 0;
}

/**
 * Attaches an SSE response to a room's fanout set.
 * Why: single choke point so the route stays thin; returns a detach closure
 * the route calls on connection close.
 * Input: account/conversation ids + express response. Output: detach fn.
 */
export function attach(res: Response, accountId: string, conversationId: string): () => void {
  const key = streamKey(accountId, conversationId);
  let set = streamClients.get(key);
  if (!set) {
    set = new Set();
    streamClients.set(key, set);
  }
  set.add(res);
  return () => {
    set!.delete(res);
    if (set!.size === 0) streamClients.delete(key);
  };
}
