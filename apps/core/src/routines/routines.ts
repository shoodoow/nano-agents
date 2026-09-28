import { routineSchema } from "@nano-agents/shared";
import { and, asc, eq, lte } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { jobs, routines } from "../db/schema.js";
import { runTurn, type TurnInput } from "../rooms/turn.js";

type Database = Pick<ReturnType<typeof getDb>, "insert" | "select" | "update" | "transaction">;

/**
 * Stores one schedule for an agent and the first job that will run it.
 * Input: database, account id, and the agent, room, message body, cron, and optional first run time.
 * Output: the saved routine and its pending job.
 */
export async function createRoutine(db: Database, accountId: string, input: unknown) {
  const data = routineSchema.parse(input);
  const runAt = data.nextRunAt ? new Date(data.nextRunAt) : new Date();
  return db.transaction(async (tx) => {
    const [routine] = await tx
      .insert(routines)
      .values({
        accountId,
        agentId: data.agentId,
        conversationId: data.conversationId,
        body: data.body,
        cron: data.cron,
        nextRunAt: runAt,
      })
      .returning();
    if (!routine) {
      throw new Error("The routine insert returned no row.");
    }
    const [job] = await tx
      .insert(jobs)
      .values({ accountId, routineId: routine.id, status: "pending", runAt })
      .returning();
    if (!job) {
      throw new Error("The job insert returned no row.");
    }
    return { routine, job };
  });
}

/**
 * Claims one due job so a second worker cannot take it.
 * Input: a database client.
 * Output: the job marked running, or null when nothing is due.
 */
export async function claimDue(db: Database) {
  return db.transaction(async (tx) => {
    const [due] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "pending"), lte(jobs.runAt, new Date())))
      .orderBy(asc(jobs.runAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!due) {
      return null;
    }
    const [claimed] = await tx.update(jobs).set({ status: "running" }).where(eq(jobs.id, due.id)).returning();
    return claimed ?? null;
  });
}

/**
 * Runs one due routine through the room turn.
 * Input: a database client and the model call. The function claims the due job itself.
 * Output: the saved replies. Mentions are decided inside runTurn.
 */
export async function runDue(db: ReturnType<typeof getDb>, generate: (input: TurnInput) => Promise<string>) {
  const job = await claimDue(db);
  if (!job) {
    return null;
  }
  const [routine] = await db
    .select()
    .from(routines)
    .where(and(eq(routines.id, job.routineId), eq(routines.accountId, job.accountId)));
  if (!routine) {
    throw new Error("Routine not found.");
  }
  const replies = await runTurn(db, routine.accountId, routine.conversationId, routine.body, generate);
  await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, job.id));
  const upcoming = nextRun(routine.cron);
  await db.update(routines).set({ nextRunAt: upcoming }).where(eq(routines.id, routine.id));
  await db.insert(jobs).values({
    accountId: routine.accountId,
    routineId: routine.id,
    status: "pending",
    runAt: upcoming,
  });
  return replies;
}

function nextRun(cron: string): Date {
  const step = cron.match(/^\*\/(\d+) \* \* \* \*$/);
  const minutes = step?.[1] ? Number(step[1]) : 1;
  return new Date(Date.now() + minutes * 60_000);
}
