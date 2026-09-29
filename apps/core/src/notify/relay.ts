import { and, eq } from "drizzle-orm";
import type { getDb, Store } from "../db/client.js";
import { agents, devices } from "../db/schema.js";
import { hasWatchers } from "../rooms/stream.js";
import { listPendingNotifications, markNotificationFailed, markNotificationSent, shouldPush } from "./notify.js";
import { checkPushReceipts, sendExpoPush } from "./push.js";

type Db = ReturnType<typeof getDb>;

/**
 * Relays one scheduler tick of pending notifications.
 * Why: the outbox (saveNotification) only records intent — this applies the
 * delivery policy and talks to Expo. In-app-only pings (room open, or
 * info+flag-off) are marked sent after fanout already showed them; pushes go
 * through sendExpoPush with receipt verification. DeviceNotRegistered prunes
 * the dead device row so tokens self-heal.
 * Input: db + injectable push sender (tests). Output: counts {sent, pushed, failed}.
 */
export async function relayNotifications(
  db: Db,
  push: typeof sendExpoPush = sendExpoPush,
  checkReceipts: typeof checkPushReceipts = checkPushReceipts,
  accountId?: string,
): Promise<{ sent: number; pushed: number; failed: number }> {
  const counts = { sent: 0, pushed: 0, failed: 0 };
  const pending = await listPendingNotifications(db, 50, accountId);
  for (const note of pending) {
    try {
      const watchers = hasWatchers(note.accountId, note.conversationId);
      const agentNotify = await resolveAgentNotify(db, note.accountId, note.agentId);
      if (!shouldPush({ hasWatchers: watchers, agentNotify, urgency: note.urgency as "info" | "action-needed" })) {
        await markNotificationSent(db, note.id);
        counts.sent += 1;
        continue;
      }
      const targets = await db
        .select()
        .from(devices)
        .where(eq(devices.accountId, note.accountId));
      if (targets.length === 0) {
        await markNotificationFailed(db, note.id, "No push devices registered for this account.");
        counts.failed += 1;
        continue;
      }
      const tickets = await push(
        targets.map((device) => ({
          to: device.expoPushToken,
          title: note.title,
          body: note.body,
          sound: "default" as const,
          data: {
            conversationId: note.conversationId,
            notificationId: note.id,
            runId: note.runId,
            messageId: note.messageId,
          },
        })),
      );
      // Pair tickets back to devices in send order.
      const failures: string[] = [];
      const receiptIds: string[] = [];
      const receiptToDevice = new Map<string, string>();
      tickets.forEach((ticket, index) => {
        const device = targets[index]!;
        if (ticket.status === "ok" && ticket.id) {
          receiptIds.push(ticket.id);
          receiptToDevice.set(ticket.id, device.id);
        } else {
          failures.push(device.expoPushToken);
        }
      });
      if (receiptIds.length > 0) {
        const receipts = await checkReceipts(receiptIds);
        for (const [ticketId, receipt] of receipts) {
          if (receipt.ok) continue;
          const deviceId = receiptToDevice.get(ticketId);
          if (receipt.error === "DeviceNotRegistered" && deviceId) {
            await db.delete(devices).where(and(eq(devices.id, deviceId), eq(devices.accountId, note.accountId)));
          }
          failures.push(ticketId);
        }
      }
      if (failures.length === 0) {
        await markNotificationSent(db, note.id);
        counts.pushed += 1;
      } else if (failures.length < targets.length) {
        // At least one device got it: delivered, with the error noted.
        await markNotificationSent(db, note.id);
        counts.pushed += 1;
      } else {
        await markNotificationFailed(db, note.id, "Push rejected for all devices.");
        counts.failed += 1;
      }
    } catch (error) {
      await markNotificationFailed(
        db,
        note.id,
        error instanceof Error ? error.message : "Relay failed.",
      ).catch(() => {});
      counts.failed += 1;
    }
  }
  return counts;
}

/**
 * Resolves the notify flag for a ping's agent.
 * Why: policy input — null agent (system pings like routine completion)
 * defaults to allowed so reports always ping unless the room is open.
 * Input: store, account id, nullable agent id. Output: the flag.
 */
async function resolveAgentNotify(store: Store, accountId: string, agentId: string | null): Promise<boolean> {
  if (!agentId) return true;
  const [agent] = await store
    .select({ notify: agents.notify })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  return agent?.notify ?? true;
}
