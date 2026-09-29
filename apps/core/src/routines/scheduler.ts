import { eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { messages } from "../db/schema.js";
import { pruneEvents } from "../rooms/events.js";
import { claimQueuedBatch } from "../rooms/rooms.js";
import { acquireRun } from "../rooms/runs.js";
import { publish } from "../rooms/stream.js";
import { reclaimStaleRuns } from "../rooms/runs.js";
import { reclaimStaleDelegations } from "../rooms/subagents.js";
import { runTurn, type TurnInput } from "../rooms/turn.js";
import { runDue } from "./routines.js";
import { relayNotifications } from "../notify/relay.js";

type Db = ReturnType<typeof getDb>;

export type SchedulerOptions = {
  // Why: options keep the loop testable — short intervals, injected model
  // stub, routine scoping, and a tick hook for assertions without waiting
  // wall-clock minutes.
  intervalMs?: number;
  staleMs?: number;
  eventRetentionDays?: number;
  skillsRoot?: string;
  generate?: (input: TurnInput) => Promise<string | { text: string }>;
  filterJob?: (job: { id: string; routineId: string; accountId: string }) => boolean;
  onTick?: (info: { jobs: number; queued: number; reclaimed: number; notified: number }) => void;
  onError?: (error: unknown, phase: string) => void;
};

/**
 * Starts the background scheduler: due routines, queued rooms, stale runs, notify relay, event prune.
 * Why: single-process interval loop (15s default) — the only thing that makes
 * routines fire, crashes heal, queued messages drain, and pings deliver with
 * nobody watching. Each phase is independently try/caught so one bad room
 * never stalls the others. Ticks never overlap (in-flight guard).
 * Input: db + options. Output: stop() — clears the timer. Unref'd.
 */
export function startScheduler(db: Db, options: SchedulerOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 15_000;
  const staleMs = options.staleMs ?? 120_000;
  const retentionDays = options.eventRetentionDays ?? 30;
  let inFlight = false;
  let stopped = false;

  const tick = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    const info = { jobs: 0, queued: 0, reclaimed: 0, notified: 0 };
    try {
      // 1. Reclaim crashed runs first so wedged rooms unblock before new work.
      try {
        const stale = await reclaimStaleRuns(db, staleMs);
        for (const run of stale) {
          publish(run.accountId, run.conversationId, {
            type: "error",
            error: "The turn stopped without finishing and was reclaimed.",
          });
        }
        info.reclaimed = stale.length;
      } catch (error) {
        options.onError?.(error, "reclaim");
      }
      // Workers use their own long threshold (hours), not the 2-minute run
      // window — a live investigation must not read as a crash.
      try {
        const wedged = await reclaimStaleDelegations(db);
        info.reclaimed += wedged.length;
      } catch (error) {
        options.onError?.(error, "workers");
      }
      // 2. Fire all due routine jobs sequentially (ledger serializes rooms).
      // runDue publishes live fanout itself; the event log always records.
      try {
        for (;;) {
          const replies = await runDue(db, {
            generate: options.generate as never,
            skillsRoot: options.skillsRoot,
            publish: true,
            filterJob: options.filterJob,
          }).catch((error: unknown) => {
            options.onError?.(error, "routine");
            return null;
          });
          if (!replies) break;
          info.jobs += 1;
        }
      } catch (error) {
        options.onError?.(error, "routine");
      }
      // 3. Drain queued busy-room arrivals, one turn per room, latest text.
      try {
        info.queued = await drainQueued(db, options);
      } catch (error) {
        options.onError?.(error, "queued");
      }
      // 4. Relay pending pings (push or in-app per policy).
      try {
        const counts = await relayNotifications(db);
        info.notified = counts.sent + counts.pushed;
      } catch (error) {
        options.onError?.(error, "notify");
      }
      // 5. Prune the resume buffer so the events table stays small.
      try {
        await pruneEvents(db, retentionDays);
      } catch (error) {
        options.onError?.(error, "prune");
      }
    } finally {
      inFlight = false;
      if (!stopped) options.onTick?.(info);
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Starts turns for rooms whose messages queued while busy.
 * Why: POST marks arrivals queued=true and returns 202 instead of holding
 * HTTP open; the drain groups by room and runs one turn per room speaking
 * for the latest queued text (earlier ones are history by then).
 * Input: db + scheduler options. Output: number of rooms drained.
 */
async function drainQueued(db: Db, options: SchedulerOptions): Promise<number> {
  const claimed = await claimQueuedBatch(db, 20);
  if (claimed.length === 0) return 0;
  const byRoom = new Map<string, typeof claimed>();
  for (const row of claimed) {
    const list = byRoom.get(row.conversationId) ?? [];
    list.push(row);
    byRoom.set(row.conversationId, list);
  }
  let drained = 0;
  for (const [conversationId, rows] of byRoom) {
    const latest = rows[rows.length - 1]!;
    try {
      const run = await acquireRun(db, latest.accountId, conversationId, "turn", 0);
      await runTurn(db, latest.accountId, conversationId, latest.body, options.generate as never, options.skillsRoot, {
        existingRunId: run.id,
      });
      drained += 1;
    } catch {
      // Still busy or failed: requeue the latest so a later tick retries.
      // Older rows already spoke via history; only the newest requeues.
      await db
        .update(messages)
        .set({ queued: true })
        .where(eq(messages.id, latest.id))
        .catch(() => {});
    }
  }
  return drained;
}
