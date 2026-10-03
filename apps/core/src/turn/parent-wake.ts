/**
 * Hidden cue turns that rewake the dispatcher after worker failure.
 * DB: messages are NOT inserted for cues; run claims runs table.
 */
import type { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";
import { takeOver } from "../desktop/desktop.js";
import { publish } from "../rooms/stream.js";
import { claimDelivery, failuresSinceLastUser, workerFollowupCue } from "../rooms/subagents.js";
import type { GenerateResult, TurnInput } from "./types.js";
import { and, eq } from "drizzle-orm";

type Db = ReturnType<typeof getDb>;

export async function resumeParentAfterWorker(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    parentAgentId: string;
    skillsRoot?: string;
    settled:
      | { workerId: string; task: string; result: string; delegationId: string; status: "done" | "failed" }
      | Array<{ workerId: string; task: string; result: string; delegationId: string; status: "done" | "failed" }>;
  },
  runTurn: (
    db: Db,
    accountId: string,
    conversationId: string,
    body: string,
    generate?: (input: TurnInput) => Promise<GenerateResult>,
    skillsRoot?: string,
    options?: { cue?: string; speakerId?: string; acquireTimeoutMs?: number; onEvent?: (event: unknown) => void },
  ) => Promise<unknown>,
): Promise<void> {
  const settledList = Array.isArray(input.settled) ? input.settled : [input.settled];
  if (settledList.some((item) => /NEEDS_PERSON:/i.test(item.result))) {
    const [parent] = await db
      .select({ linuxProfile: agents.linuxProfile })
      .from(agents)
      .where(and(eq(agents.id, input.parentAgentId), eq(agents.accountId, input.accountId)));
    if (parent?.linuxProfile) takeOver(input.accountId, parent.linuxProfile);
  }
  const allFailed = settledList.every((item) => item.status === "failed");
  const failures = allFailed
    ? await failuresSinceLastUser(db, input.accountId, input.conversationId, input.parentAgentId)
    : 0;
  const cue = allFailed
    ? workerFollowupCue({
        workerId: settledList[0]?.workerId ?? "",
        task: settledList[0]?.task ?? "",
        result: settledList[0]?.result ?? "",
        settled: settledList,
        retry: failures <= 1,
      })
    : workerCompletionCue(settledList);
  await runTurn(db, input.accountId, input.conversationId, cue, undefined, input.skillsRoot, {
    cue,
    speakerId: input.parentAgentId,
    acquireTimeoutMs: 120_000,
    onEvent: (event) => publish(input.accountId, input.conversationId, event as never),
  });
  await Promise.all(settledList.map((item) => claimDelivery(db, item.delegationId).catch(() => false)));
}

/** Hidden completion cue: evidence goes to the parent, never straight to chat. */
function workerCompletionCue(
  settled: Array<{ task: string; result: string; status: "done" | "failed" }>,
): string {
  const reports = settled
    .map(
      (item, index) =>
        `Result ${index + 1} (${item.status}) for "${item.task.slice(0, 300)}":\n${item.result.slice(0, 6_000)}`,
    )
    .join("\n\n");
  return (
    `[worker results — private to manager]\n${reports}\n\n` +
    "Review these reports and decide what belongs in the room. The worker has no voice and must not be quoted raw. " +
    "Send a concise human update only when useful. If a report names a /shared artifact the person asked for, attach it as a file block. " +
    "Never expose Findings/What I did/Blockers labels, worker ids, tool logs, or implementation details."
  );
}
