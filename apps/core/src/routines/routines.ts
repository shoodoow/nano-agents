import { routineSchema } from "@nano-agents/shared";
import { routineCreateInputSchema, routineIdSchema, routineUpdateInputSchema } from "@nano-agents/agent-tools";
import { and, asc, eq, lte } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import type { Store } from "../db/client.js";
import { jobs, routines } from "../db/schema.js";
import { acquireRun } from "../rooms/runs.js";
import { publish } from "../rooms/stream.js";
import { runTurn, type TurnInput } from "../rooms/turn.js";
import type { StreamEvent } from "../rooms/stream.js";
import { nextCronRun } from "./cron.js";

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
 * Why: paused routines never fire — claiming joins routines and skips them.
 * Input: a database client.
 * Output: the job marked running, or null when nothing is due.
 */
export async function claimDue(db: Database) {
  return db.transaction(async (tx) => {
    const [due] = await tx
      .select({ job: jobs })
      .from(jobs)
      .innerJoin(routines, eq(jobs.routineId, routines.id))
      .where(and(eq(jobs.status, "pending"), lte(jobs.runAt, new Date()), eq(routines.paused, false)))
      .orderBy(asc(jobs.runAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!due) {
      return null;
    }
    const [claimed] = await tx.update(jobs).set({ status: "running" }).where(eq(jobs.id, due.job.id)).returning();
    return claimed ?? null;
  });
}

/**
 * Lists due pending jobs oldest-first without claiming.
 * Why: the scheduler filters (tests scope to their routine; future shards by
 * tenant) BEFORE claiming, so ticks never steal each other's work. Bounded.
 * Paused routines are excluded here, not at claim time.
 * Input: db, limit. Output: due pending jobs.
 */
export async function listDueJobs(db: Database, limit = 20) {
  const rows = await db
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(routines, eq(jobs.routineId, routines.id))
    .where(and(eq(jobs.status, "pending"), lte(jobs.runAt, new Date()), eq(routines.paused, false)))
    .orderBy(asc(jobs.runAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((row) => row.job);
}

/**
 * Claims one specific job only if still pending (single atomic statement).
 * Why: claim-then-filter would wedge foreign jobs as running; claim-by-id
 * after filtering keeps unclaimed jobs claimable by their rightful worker.
 * Input: db, job id. Output: the running job, or null when already taken.
 */
export async function claimJob(db: Database, jobId: string) {
  const [claimed] = await db
    .update(jobs)
    .set({ status: "running" })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "pending")))
    .returning();
  return claimed ?? null;
}

/**
 * Runs one due routine through the room turn.
 * Why: routines share the exact turn path as human messages (same prompt,
 * for audits and push copy. A busy room defers the job 30s instead of piling
 * on; any other failure marks the job failed but still reschedules, so one
 * bad run never kills the routine.
 * Input: db + optional generate stub / onEvent fanout / skillsRoot.
 * Output: saved replies, or null when no job is due or the room is busy.
 */
export async function runDue(
  db: ReturnType<typeof getDb>,
  generateOrOpts?: ((input: TurnInput) => Promise<string>) | {
    generate?: (input: TurnInput) => Promise<string>;
    onEvent?: (event: StreamEvent) => void;
    skillsRoot?: string;
    // Why: the scheduler has no room watchers of its own — live fanout for
    // routine runs is published here where account+room are known, using the
    // same shape as user turns so clients cannot tell them apart.
    publish?: boolean;
    // Why: list-then-claim lets callers scope to their jobs (tests isolate by
    // routine; future shards by tenant) without wedging foreign jobs running.
    filterJob?: (job: { id: string; routineId: string; accountId: string }) => boolean;
  },
) {
  const opts = typeof generateOrOpts === "function" ? { generate: generateOrOpts } : (generateOrOpts ?? {});
  // List-then-claim (not blind claimDue) so the filter never wedges foreign
  // jobs: skipped jobs stay pending for their rightful worker.
  const due = await listDueJobs(db, 20);
  let job: (typeof due)[number] | null = null;
  for (const candidate of due) {
    if (opts.filterJob && !opts.filterJob(candidate)) continue;
    const claimed = await claimJob(db, candidate.id);
    if (claimed) {
      job = claimed;
      break;
    }
  }
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
  const reschedule = async () => {
    const upcoming = nextRun(routine.cron, routine.timezone);
    await db.update(routines).set({ nextRunAt: upcoming }).where(eq(routines.id, routine.id));
    await db.insert(jobs).values({
      accountId: routine.accountId,
      routineId: routine.id,
      status: "pending",
      runAt: upcoming,
    });
  };
  let runId: string | null = null;
  try {
    try {
      // Fail-fast claim: a busy room defers (job back to pending, retry soon)
      // instead of blocking the whole scheduler tick for minutes.
      runId = (await acquireRun(db, routine.accountId, routine.conversationId, "routine", 0)).id;
    } catch (error) {
      if (error instanceof Error && /busy/.test(error.message)) {
        await db.update(jobs).set({ status: "pending", runAt: new Date(Date.now() + 30_000) }).where(eq(jobs.id, job.id));
        return null;
      }
      throw error;
    }
    const replies = await runTurn(db, routine.accountId, routine.conversationId, routine.body, opts.generate as never, opts.skillsRoot, {
      existingRunId: runId,
      kind: "routine",
      onEvent: (event) => {
        if (opts.publish) publish(routine.accountId, routine.conversationId, event);
        opts.onEvent?.(event);
      },
    });
    await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, job.id));
    await reschedule();
    return replies;
  } catch (error) {
    await db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, job.id));
    await reschedule();
    throw error;
  }
}

/**
 * Computes the next fire time for a cron expression in its timezone.
 * Why: thin wrapper so routine code never hand-rolls date math — daily
 * "09:00 Europe/Berlin" survives DST via the shared parser. Pure.
 * Input: cron text + IANA timezone. Output: the next run Date.
 */
export function nextRun(cron: string, timezone = "UTC"): Date {
  return nextCronRun(cron, timezone);
}

/**
 * Creates a routine owned by the calling agent.
 * Why: owner-scoped self-automation — "remind me daily at 9" works without
 * human console steps, and one agent can never schedule work as another.
 * The first job fires at the next cron occurrence (not immediately), so
 * "every day at 09:00" means 09:00, not now.
 * Input: store, account/room/caller ids, {body, cron, timezone?, paused?}.
 * Output: the saved routine. Throws on bad cron/timezone.
 */
export async function createOwnRoutine(
  store: Store,
  input: { accountId: string; conversationId: string; agentId: string; body: string; cron: string; timezone?: string; paused?: boolean },
) {
  const data = routineCreateInputSchema.parse({
    body: input.body,
    cron: input.cron,
    timezone: input.timezone ?? "UTC",
    paused: input.paused ?? false,
  });
  const runAt = nextCronRun(data.cron, data.timezone);
  const [routine] = await store
    .insert(routines)
    .values({
      accountId: input.accountId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      body: data.body,
      cron: data.cron,
      timezone: data.timezone,
      paused: data.paused,
      nextRunAt: runAt,
    })
    .returning();
  if (!routine) throw new Error("The routine insert returned no row.");
  if (!data.paused) {
    await store.insert(jobs).values({ accountId: input.accountId, routineId: routine.id, status: "pending", runAt });
  }
  return routine;
}

/**
 * Lists the calling agent's own routines.
 * Why: the model needs ids to update/delete, without dumping the whole
 * account's schedules into the prompt.
 * Input: store, account + caller ids. Output: own routines, soonest first.
 */
export async function listOwnRoutines(store: Store, accountId: string, agentId: string) {
  return store
    .select({
      id: routines.id,
      body: routines.body,
      cron: routines.cron,
      timezone: routines.timezone,
      paused: routines.paused,
      nextRunAt: routines.nextRunAt,
    })
    .from(routines)
    .where(and(eq(routines.accountId, accountId), eq(routines.agentId, agentId)))
    .orderBy(asc(routines.nextRunAt));
}

/**
 * Updates the calling agent's own routine.
 * Why: ownership enforced in the WHERE clause — the update touches zero rows
 * for foreign ids, which reads as "not found" instead of leaking existence.
 * Reschedules the pending job when cron/timezone changes (paused flips stop
 * or restart firing accordingly).
 * Input: store, account/caller ids, {routineId, body?, cron?, timezone?, paused?}.
 * Output: the updated routine, or null when not owned.
 */
export async function updateOwnRoutine(
  store: Store,
  accountId: string,
  agentId: string,
  input: { routineId: string; body?: string; cron?: string; timezone?: string; paused?: boolean },
) {
  const data = routineUpdateInputSchema.parse(input);
  const [owned] = await store
    .select()
    .from(routines)
    .where(and(eq(routines.id, data.routineId), eq(routines.accountId, accountId), eq(routines.agentId, agentId)));
  if (!owned) return null;
  const patch: Partial<{ body: string; cron: string; timezone: string; paused: boolean; nextRunAt: Date }> = {};
  if (data.body !== undefined) patch.body = data.body;
  if (data.timezone !== undefined) patch.timezone = data.timezone;
  if (data.paused !== undefined) patch.paused = data.paused;
  if (data.cron !== undefined) {
    patch.cron = data.cron;
    patch.nextRunAt = nextCronRun(data.cron, data.timezone ?? owned.timezone);
  } else if (data.timezone !== undefined) {
    patch.nextRunAt = nextCronRun(owned.cron, data.timezone);
  }
  if (Object.keys(patch).length === 0) return owned;
  const [updated] = await store
    .update(routines)
    .set(patch)
    .where(and(eq(routines.id, data.routineId), eq(routines.accountId, accountId), eq(routines.agentId, agentId)))
    .returning();
  if (!updated) return null;
  if (data.paused === true) {
    // Pausing parks pending jobs; they resume on unpause via the new job below.
    await store.update(jobs).set({ status: "done" }).where(and(eq(jobs.routineId, updated.id), eq(jobs.status, "pending")));
  }
  if (data.paused === false || data.cron !== undefined || data.timezone !== undefined) {
    const runAt = updated.nextRunAt;
    const [existing] = await store
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.routineId, updated.id), eq(jobs.status, "pending")));
    if (!existing && !updated.paused) {
      await store.insert(jobs).values({ accountId, routineId: updated.id, status: "pending", runAt });
    }
  }
  return updated;
}

/**
 * Deletes the calling agent's own routine and its pending jobs.
 * Why: owner-scoped like update — foreign ids read as not found.
 * Input: store, account/caller ids, routine id. Output: true when deleted.
 */
export async function deleteOwnRoutine(store: Store, accountId: string, agentId: string, routineId: string): Promise<boolean> {
  const id = routineIdSchema.parse({ routineId }).routineId;
  const [owned] = await store
    .select({ id: routines.id })
    .from(routines)
    .where(and(eq(routines.id, id), eq(routines.accountId, accountId), eq(routines.agentId, agentId)));
  if (!owned) return false;
  await store.delete(jobs).where(and(eq(jobs.routineId, id), eq(jobs.accountId, accountId)));
  const deleted = await store
    .delete(routines)
    .where(and(eq(routines.id, id), eq(routines.accountId, accountId), eq(routines.agentId, agentId)))
    .returning({ id: routines.id });
  return deleted.length > 0;
}
