/**
 * Hidden cue turns that rewake the dispatcher after worker failure.
 * DB: messages are NOT inserted for cues; run claims runs table.
 */
import type { getDb } from "../db/client.js";
import { publish } from "../rooms/stream.js";
import { failuresSinceLastUser, workerFollowupCue } from "../rooms/subagents.js";
import type { GenerateResult, TurnInput } from "./types.js";

type Db = ReturnType<typeof getDb>;

export async function resumeParentAfterWorker(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    parentAgentId: string;
    skillsRoot?: string;
    settled:
      | { workerId: string; task: string; result: string }
      | Array<{ workerId: string; task: string; result: string }>;
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
  const failures = await failuresSinceLastUser(db, input.accountId, input.conversationId, input.parentAgentId);
  const settledList = Array.isArray(input.settled) ? input.settled : [input.settled];
  const cue = workerFollowupCue({
    workerId: settledList[0]?.workerId ?? "",
    task: settledList[0]?.task ?? "",
    result: settledList[0]?.result ?? "",
    settled: settledList,
    retry: failures <= 1,
  });
  await runTurn(db, input.accountId, input.conversationId, cue, undefined, input.skillsRoot, {
    cue,
    speakerId: input.parentAgentId,
    acquireTimeoutMs: 120_000,
    onEvent: (event) => publish(input.accountId, input.conversationId, event as never),
  });
}
