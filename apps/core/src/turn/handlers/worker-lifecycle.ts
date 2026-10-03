/**
 * Subscribes to worker.settled on TurnBus — parent always gets delivery or wake.
 * DB: delegations.result already set by runWorker before emit.
 */
import type { getDb } from "../../db/client.js";
import { subscribeTurnBus } from "../events/bus.js";
import { resumeParentAfterWorker } from "../parent-wake.js";

type Db = ReturnType<typeof getDb>;

let registered = false;

interface PendingWake {
  timer: ReturnType<typeof setTimeout>;
  accountId: string;
  parentAgentId: string;
  skillsRoot?: string;
  events: Array<{
    workerId: string;
    task: string;
    result: string;
    delegationId: string;
    status: "done" | "failed";
  }>;
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

    // Every result goes privately through the parent. Hidden workers never
    // publish in the parent's voice; the parent reviews, summarizes, attaches
    // artifacts, retries, or stays quiet. Batch concurrent completions.
    const existing = pendingWakesByConversation.get(event.conversationId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.events.push({
        workerId: event.workerId,
        task: event.task,
        result: event.result,
        delegationId: event.delegationId,
        status: event.status,
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
          status: event.status,
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
