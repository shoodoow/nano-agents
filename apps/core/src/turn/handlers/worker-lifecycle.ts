/**
 * Subscribes to worker.settled on TurnBus — parent always gets delivery or wake.
 * DB: delegations.result already set by runWorker before emit.
 */
import type { getDb } from "../../db/client.js";
import { subscribeTurnBus } from "../events/bus.js";
import { deliverWorkerResult } from "../worker-delivery.js";
import { resumeParentAfterWorker } from "../parent-wake.js";

type Db = ReturnType<typeof getDb>;

let registered = false;

export function registerWorkerLifecycle(
  getDbInstance: () => Db,
  runTurn: Parameters<typeof resumeParentAfterWorker>[2],
): void {
  if (registered) return;
  registered = true;
  subscribeTurnBus(async (event) => {
    if (event.type !== "worker.settled") return;
    const db = getDbInstance();
    if (event.status !== "failed") {
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
    await resumeParentAfterWorker(
      db,
      {
        accountId: event.accountId,
        conversationId: event.conversationId,
        parentAgentId: event.parentAgentId,
        skillsRoot: event.skillsRoot,
        settled: { workerId: event.workerId, task: event.task, result: event.result },
      },
      runTurn,
    ).catch(() => {});
  });
}
