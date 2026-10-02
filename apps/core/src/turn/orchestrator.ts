/**
 * Room turn orchestration: run ledger, speaker queue, queue drain.
 * DB: runs, messages, events (via TurnEmitter).
 */
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, conversations, members, messages } from "../db/schema.js";
import { speakers } from "../rooms/mentions.js";
import { claimQueuedForRoom, saveUserMessage } from "../rooms/rooms.js";
import { acquireRun, failRun, finishRun, heartbeatRun } from "../rooms/runs.js";
import type { StreamEvent } from "../rooms/stream.js";
import { HEARTBEAT_MS } from "./constants.js";
import { TurnEmitter } from "./events/emitter.js";
import { registerWorkerLifecycle } from "./handlers/worker-lifecycle.js";
import { speakOnce } from "./speaker.js";
import { compactConversation } from "../memory/compact-turn.js";
import type { GenerateResult, TurnInput, TurnOptions } from "./types.js";

type Db = ReturnType<typeof getDb>;

let workerLifecycleReady = false;
function ensureWorkerLifecycle(db: Db): void {
  if (workerLifecycleReady) return;
  workerLifecycleReady = true;
  registerWorkerLifecycle(() => db, runTurn);
}

export async function runTurn(
  db: Db,
  accountId: string,
  conversationId: string,
  body: string | { text: string; blocks?: { kind: string; [key: string]: unknown }[] | null; replyTo?: string | null },
  generate?: (input: TurnInput) => Promise<GenerateResult>,
  skillsRoot?: string,
  options?: TurnOptions,
) {
  ensureWorkerLifecycle(db);
  const [room] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  if (!room) throw new Error("Room not found");

  const memberRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(members)
    .innerJoin(agents, eq(members.agentId, agents.id))
    .where(and(eq(members.conversationId, conversationId), eq(members.accountId, accountId)));

  const runId =
    options?.existingRunId ??
    (await acquireRun(db, accountId, conversationId, options?.kind ?? "turn", options?.acquireTimeoutMs)).id;
  await heartbeatRun(db, runId).catch(() => {});

  const emitter = new TurnEmitter(db, {
    accountId,
    conversationId,
    runId,
    onEvent: options?.onEvent,
  });
  const emit = (event: Parameters<TurnEmitter["emit"]>[0]) => emitter.emit(event);

  // Wall clock per bubble so a long turn does not back-date replies before
  // messages the person sent while the agent was still thinking.
  let stamp = 0;
  const nextTime = () => {
    const now = Date.now();
    stamp = stamp === 0 ? now : Math.max(stamp + 1, now);
    return new Date(stamp);
  };
  const incoming = typeof body === "string" ? { text: body, blocks: null as null, replyTo: null as null } : body;
  if (!options?.cue) {
    if (options?.alreadySavedUserMessage) {
      await db
        .update(messages)
        .set({ runId })
        .where(and(eq(messages.id, options.alreadySavedUserMessage.id), eq(messages.accountId, accountId)));
    } else {
      await saveUserMessage(db, accountId, conversationId, {
        text: incoming.text,
        blocks: incoming.blocks,
        replyTo: incoming.replyTo,
        runId,
      });
    }
  }

  const beat = setInterval(() => {
    void heartbeatRun(db, runId).catch(() => {});
  }, HEARTBEAT_MS);
  (beat as unknown as { unref?: () => void }).unref?.();

  const saved: (typeof messages.$inferSelect)[] = [];
  // Billable usage for this run: every speaker adds its harness total.
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, steps: 0 };
  try {
    const spoken = new Set<string>();
    const queue = options?.speakerId ? [options.speakerId] : speakers(incoming.text, memberRows, room.ownerAgentId);
    while (queue.length > 0) {
      const agentId = queue.shift();
      if (!agentId || spoken.has(agentId)) continue;
      spoken.add(agentId);
      await speakOnce(db, {
        accountId,
        conversationId,
        agentId,
        memberRows,
        room,
        skillsRoot,
        generate,
        nextTime,
        runId,
        emit,
        saved,
        queue,
        spoken,
        cue: options?.cue,
        usage,
      });
      await heartbeatRun(db, runId).catch(() => {});
    }
    await compactConversation(db, accountId, conversationId);
    await finishRun(
      db,
      runId,
      usage.steps > 0
        ? {
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            reasoningTokens: usage.reasoning,
            modelSteps: usage.steps,
          }
        : undefined,
    );
    await emit({ type: "run", run: { id: runId, status: "done" as const, error: null } });
    emitter.emitDone();
    return saved;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The turn failed.";
    await failRun(db, runId, message).catch(() => {});
    await emit({ type: "error", error: message });
    throw error;
  } finally {
    clearInterval(beat);
    await continueQueuedTurn(db, accountId, conversationId, generate, skillsRoot, options?.onEvent).catch(() => {});
  }
}

export async function continueQueuedTurn(
  db: Db,
  accountId: string,
  conversationId: string,
  generate?: (input: TurnInput) => Promise<GenerateResult>,
  skillsRoot?: string,
  onEvent?: (event: StreamEvent) => void,
): Promise<boolean> {
  const claimed = await claimQueuedForRoom(db, accountId, conversationId);
  const latest = claimed[claimed.length - 1];
  if (!latest) return false;
  let runId: string;
  try {
    runId = (await acquireRun(db, accountId, conversationId, "turn", 0)).id;
  } catch (error) {
    await db
      .update(messages)
      .set({ queued: true })
      .where(and(eq(messages.id, latest.id), eq(messages.accountId, accountId)))
      .catch(() => {});
    if (error instanceof Error && /busy/.test(error.message)) return false;
    throw error;
  }
  await runTurn(db, accountId, conversationId, latest.body, generate, skillsRoot, {
    existingRunId: runId,
    alreadySavedUserMessage: { id: latest.id, text: latest.body },
    onEvent,
  });
  return true;
}
