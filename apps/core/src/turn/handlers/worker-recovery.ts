/**
 * Picks interrupted workers back up after the core process restarts.
 * Why: a worker's model loop lives in this process. A restart (a deploy, a
 * crash, a file save under `tsx watch`) used to leave its row reading
 * "running" for hours with nothing behind it, and the agent kept telling the
 * person the job was in progress. The worker's conversation is saved as it
 * goes, so a recent job continues from where it was; an old one is closed.
 * DB: reads delegations + worker_transcripts; closes stale rows.
 */
import { and, eq } from "drizzle-orm";
import type { getDb } from "../../db/client.js";
import { agents, delegations, workerTranscripts } from "../../db/schema.js";
import { prompt } from "../../prompt/prompts.js";
import { isWorkerLive, runWorker } from "../../rooms/subagents.js";
import { emitTurnBus } from "../events/bus.js";

type Db = ReturnType<typeof getDb>;

/** A job whose last sign of life is older than this is closed instead of continued. */
export const RECOVER_WITHIN_MS = 45 * 60 * 1000;

const INTERRUPTED =
  "Interrupted when the system restarted, before it finished. What it did is saved: continue it with redirect_worker and it carries on from there.";

/**
 * Continues or closes every worker that was running when the process stopped.
 * Input: db and the skills folder. Output: how many were continued and closed.
 */
export async function recoverInterruptedWorkers(
  db: Db,
  skillsRoot?: string,
): Promise<{ continued: number; closed: number }> {
  const rows = await db
    .select({
      id: delegations.id,
      accountId: delegations.accountId,
      conversationId: delegations.conversationId,
      parentAgentId: delegations.parentAgentId,
      childAgentId: delegations.childAgentId,
      task: delegations.task,
      heartbeatAt: delegations.heartbeatAt,
    })
    .from(delegations)
    .innerJoin(agents, eq(agents.id, delegations.childAgentId))
    .where(and(eq(delegations.status, "running"), eq(agents.hidden, true)));
  let continued = 0;
  let closed = 0;
  for (const row of rows) {
    if (isWorkerLive(row.id)) continue;
    const recent = Date.now() - row.heartbeatAt.getTime() < RECOVER_WITHIN_MS;
    const [saved] = recent
      ? await db
          .select({ delegationId: workerTranscripts.delegationId })
          .from(workerTranscripts)
          .where(eq(workerTranscripts.delegationId, row.id))
      : [];
    if (recent && saved) {
      continued += 1;
      void runWorker(db, {
        accountId: row.accountId,
        conversationId: row.conversationId,
        parentAgentId: row.parentAgentId,
        childId: row.childAgentId,
        delegationId: row.id,
        task: row.task,
        skillsRoot,
        resumeFrom: row.id,
        resumeNote: prompt("worker-rules", "restart-note"),
        onSettled: (settled) => {
          void emitTurnBus({
            type: "worker.settled",
            accountId: row.accountId,
            conversationId: row.conversationId,
            parentAgentId: row.parentAgentId,
            delegationId: row.id,
            skillsRoot,
            workerId: settled.workerId,
            task: settled.task,
            result: settled.result,
            status: settled.status,
          });
        },
      });
      continue;
    }
    // Too old to pick up unasked, or nothing was saved. Closed quietly: waking
    // the agent hours later would send the person a message out of nowhere.
    const updated = await db
      .update(delegations)
      .set({ status: "failed", result: INTERRUPTED, progress: "Interrupted by a restart.", delivered: true })
      .where(and(eq(delegations.id, row.id), eq(delegations.status, "running")))
      .returning({ id: delegations.id });
    if (updated.length > 0) closed += 1;
  }
  return { continued, closed };
}
