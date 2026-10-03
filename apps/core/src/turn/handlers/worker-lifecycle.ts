/**
 * Subscribes to worker.settled on TurnBus — parent always gets delivery or wake.
 * DB: delegations.result already set by runWorker before emit.
 */
import type { getDb } from "../../db/client.js";
import { subscribeTurnBus } from "../events/bus.js";
import { resumeParentAfterWorker } from "../parent-wake.js";
import { deliverWorkerResult } from "../worker-delivery.js";
import { isEmptyWorkerReport } from "../worker-report.js";
import { failuresSinceLastUser } from "../../rooms/subagents.js";

type Db = ReturnType<typeof getDb>;

let registered = false;

interface PendingWake {
  timer: ReturnType<typeof setTimeout>;
  accountId: string;
  parentAgentId: string;
  skillsRoot?: string;
  events: Array<{ workerId: string; task: string; result: string; delegationId: string }>;
}

const pendingWakesByConversation = new Map<string, PendingWake>();

export function registerWorkerLifecycle(
  getDbInstance: () => Db,
  runTurn: Parameters<typeof resumeParentAfterWorker>[2],
): void {
  if (registered) return;
  registered = true;
  subscribeTurnBus(async (event) => {
    if (event.type !== "worker.settled") return;
    const db = getDbInstance();

    // Success path: Deliver result directly in parent's voice (no model call required).
    if (event.status !== "failed" && !isEmptyWorkerReport(event.result)) {
      await deliverWorkerResult(db, {
        accountId: event.accountId,
        conversationId: event.conversationId,
        parentAgentId: event.parentAgentId,
        delegationId: event.delegationId,
        skillsRoot: event.skillsRoot,
        settled: { workerId: event.workerId, task: event.task, result: event.result },
      }).catch(() => {});
      return;
    }

    // Failure path:
    // Check if retries are exhausted. If 2+ failures already occurred and this worker
    // has a non-empty report, deliver the report directly to the room instead of burning
    // another 15k-token dispatcher turn just to echo the error.
    const recentFails = await failuresSinceLastUser(
      db,
      event.accountId,
      event.conversationId,
      event.parentAgentId,
    ).catch(() => 0);

    if (recentFails >= 2 && !isEmptyWorkerReport(event.result)) {
      await deliverWorkerResult(db, {
        accountId: event.accountId,
        conversationId: event.conversationId,
        parentAgentId: event.parentAgentId,
        delegationId: event.delegationId,
        skillsRoot: event.skillsRoot,
        settled: { workerId: event.workerId, task: event.task, result: event.result },
      }).catch(() => {});
      return;
    }

    // Otherwise, wake parent. Debounce by conversation so concurrent worker settlements
    // are batched into a single parent turn rather than triggering multiple sequential turns.
    const existing = pendingWakesByConversation.get(event.conversationId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.events.push({
        workerId: event.workerId,
        task: event.task,
        result: event.result,
        delegationId: event.delegationId,
      });
      existing.timer = setTimeout(() => {
        pendingWakesByConversation.delete(event.conversationId);
        void resumeParentAfterWorker(
          db,
          {
            accountId: existing.accountId,
            conversationId: event.conversationId,
            parentAgentId: existing.parentAgentId,
            skillsRoot: existing.skillsRoot,
            settled: existing.events,
          },
          runTurn,
        ).catch(() => {});
      }, 1500);
      (existing.timer as unknown as { unref?: () => void }).unref?.();
      return;
    }

    const pending: PendingWake = {
      accountId: event.accountId,
      parentAgentId: event.parentAgentId,
      skillsRoot: event.skillsRoot,
      events: [
        {
          workerId: event.workerId,
          task: event.task,
          result: event.result,
          delegationId: event.delegationId,
        },
      ],
      timer: setTimeout(() => {
        pendingWakesByConversation.delete(event.conversationId);
        void resumeParentAfterWorker(
          db,
          {
            accountId: event.accountId,
            conversationId: event.conversationId,
            parentAgentId: event.parentAgentId,
            skillsRoot: event.skillsRoot,
            settled: pending.events.length === 1 ? pending.events[0]! : pending.events,
          },
          runTurn,
        ).catch(() => {});
      }, 1500),
    };
    (pending.timer as unknown as { unref?: () => void }).unref?.();
    pendingWakesByConversation.set(event.conversationId, pending);
  });
}
