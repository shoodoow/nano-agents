import { and, desc, eq } from "drizzle-orm";
import { Router } from "express";
import { notifications } from "../../db/schema.js";
import { pathParam, queryAccountId, type AppContext, type Guard } from "../context.js";

/**
 * Routes under /notifications: pings the phone has not shown yet.
 * Input: the request context and the session guard. Output: the router.
 */
export function notificationsRoutes(ctx: AppContext, guard: Guard): Router {
  const router = Router();
  router.get("/", guard, async (req, res) => {
    // Pending pings for the badge/inbox. Why: pushes can be missed or
    // dismissed — the list is the durable fallback the phone reconciles on
    // every foreground, newest first, capped for cheap polling.
    const accountId = queryAccountId(req);
    const pendingOnly = req.query.pending !== "0";
    const rows = await ctx.db
      .select()
      .from(notifications)
      .where(
        pendingOnly
          ? and(eq(notifications.accountId, accountId), eq(notifications.status, "pending"))
          : eq(notifications.accountId, accountId),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    res.json(rows);
  });
  router.post("/:id/ack", guard, async (req, res) => {
    // The phone showed this ping in-app. Why: without a push device the row
    // stays pending, and acking stops the banner from repeating.
    const accountId = queryAccountId(req);
    const [row] = await ctx.db
      .update(notifications)
      .set({ status: "sent" })
      .where(
        and(
          eq(notifications.id, pathParam(req, "id")),
          eq(notifications.accountId, accountId),
          eq(notifications.status, "pending"),
        ),
      )
      .returning({ id: notifications.id });
    if (!row) {
      res.status(404).json({ error: "Notification not found." });
      return;
    }
    res.json({ id: row.id });
  });
  return router;
}
