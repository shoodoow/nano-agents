import type { Response } from "express";
import { config } from "../config.js";
import { findRoom } from "../rooms/rooms.js";
import { acquireRun, RoomBusyError } from "../rooms/runs.js";
import { publish, type StreamEvent } from "../rooms/stream.js";
import { runTurn } from "../rooms/turn.js";
import { approvalDecisionCue, decideToolApproval, isApprovalAwaited, markApprovalWidget } from "../turn/auto-review.js";
import { logger, type AppContext } from "./context.js";

/**
 * Decides one Auto-review card, updates the chat widget, and cue-wakes the room agent.
 * Why: approve must not 404 on a second tap, and the model only retries after a wake.
 */
export async function decideToolApprovalHttp(
  ctx: AppContext,
  accountId: string,
  approvalId: string,
  decision: "approved" | "denied",
  res: Response,
): Promise<void> {
  const updated = await decideToolApproval(ctx.db, accountId, approvalId, decision);
  if (!updated) {
    res.status(404).json({ error: "Approval not found." });
    return;
  }
  const marked = await markApprovalWidget(ctx.db, accountId, updated.conversationId, updated.id, decision);
  if (marked) {
    publish(accountId, updated.conversationId, { type: "message", message: marked });
  }
  res.json(updated);
  // A worker paused on this card carries on by itself; waking the agent too
  // made it restart that worker from nothing.
  if (isApprovalAwaited(updated.id)) return;
  const room = await findRoom(ctx.db, accountId, updated.conversationId);
  if (!room) return;
  await startCueTurn(ctx, {
    accountId,
    conversationId: updated.conversationId,
    cue: approvalDecisionCue(updated, decision),
    speakerId: room.ownerAgentId,
    label: "approval",
  }).catch((error: unknown) => {
    logger.error({ err: error, conversationId: updated.conversationId }, "approval wake acquire failed");
  });
}

/**
 * Wakes one agent with a private note, in the background, when the room is free.
 * Why: a reaction, a widget pick and an approval all start a turn the same
 * way; a busy room is an ordinary outcome each caller answers differently.
 * Input: the request context and the room, note, speaker and a log label.
 * Output: true when the turn started, false when the room was busy.
 */
export async function startCueTurn(
  ctx: AppContext,
  input: { accountId: string; conversationId: string; cue: string; speakerId: string; label: string },
): Promise<boolean> {
  const { accountId, conversationId, cue, speakerId, label } = input;
  let runId: string;
  try {
    runId = (await acquireRun(ctx.db, accountId, conversationId, "turn", 0)).id;
  } catch (error) {
    if (error instanceof RoomBusyError) return false;
    throw error;
  }
  void runTurn(ctx.db, accountId, conversationId, cue, ctx.generate, config.skillsDir(), {
    cue,
    speakerId,
    existingRunId: runId,
    onEvent: (event: StreamEvent) => publish(accountId, conversationId, event),
  }).catch((error: unknown) => {
    logger.error({ err: error, conversationId }, `${label} turn failed`);
  });
  return true;
}
