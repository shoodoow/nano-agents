/**
 * Posts finished worker output to the room in the parent's voice.
 * DB: messages insert, events append, optional notifications + desktop handover.
 */
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";
import { takeOver } from "../desktop/desktop.js";
import { saveNotification } from "../notify/notify.js";
import { appendEvent } from "../rooms/events.js";
import { saveSendMessage } from "../rooms/send-message.js";
import { publish } from "../rooms/stream.js";
import { alreadyDelivered, claimDelivery } from "../rooms/subagents.js";
import type { GenerateResult, TurnInput } from "./types.js";
import { isEmptyWorkerReport, workerResultForPerson } from "./worker-report.js";

type Db = ReturnType<typeof getDb>;

export async function deliverWorkerResult(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    parentAgentId: string;
    delegationId: string;
    skillsRoot?: string;
    settled: { workerId: string; task: string; result: string };
    generate?: (input: TurnInput) => Promise<GenerateResult>;
  },
): Promise<"delivered" | "skipped"> {
  const raw = input.settled.result.trim().slice(0, 4000);
  if (isEmptyWorkerReport(raw)) return "skipped";
  if (
    await alreadyDelivered(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      parentAgentId: input.parentAgentId,
      result: input.settled.result,
    })
  ) {
    return "skipped";
  }
  if (!(await claimDelivery(db, input.delegationId))) {
    return "skipped";
  }
  const presentable = workerResultForPerson(raw);
  const needs = presentable.match(/NEEDS_PERSON:\s*(.+)/i);
  const text = needs
    ? `I need you on my computer. ${needs[1].trim()} Tell me when you're done and I'll continue.`
    : presentable;
  if (needs) {
    const [parent] = await db
      .select({ linuxProfile: agents.linuxProfile })
      .from(agents)
      .where(and(eq(agents.id, input.parentAgentId), eq(agents.accountId, input.accountId)));
    if (parent?.linuxProfile) takeOver(input.accountId, parent.linuxProfile);
    const note = await saveNotification(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      agentId: input.parentAgentId,
      title: "Your turn on my computer",
      body: needs[1].trim().slice(0, 240),
      urgency: "action-needed",
    }).catch(() => null);
    if (note) {
      publish(input.accountId, input.conversationId, { type: "notify", notification: note });
    }
  }
  const saved = await saveSendMessage(db, {
    accountId: input.accountId,
    conversationId: input.conversationId,
    agentId: input.parentAgentId,
    blocks: [{ kind: "text", markdown: text }],
    createdAt: new Date(),
  });
  const logged = await appendEvent(db, {
    accountId: input.accountId,
    conversationId: input.conversationId,
    event: { type: "message", message: saved },
  }).catch(() => null);
  publish(input.accountId, input.conversationId, {
    type: "message",
    message: saved,
    ...(logged ? { cursor: logged.id } : {}),
  });
  return "delivered";
}
