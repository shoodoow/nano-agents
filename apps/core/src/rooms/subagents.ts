import { delegateSchema, spawnWorkerInputSchema, subagentCreateSchema, workerRefSchema } from "@nano-agents/agent-tools";
import {
  packWorkerJobDescription,
  unpackWorkerJobDescription,
  workerPreambleFor,
  type WorkerKind,
} from "./worker-kinds.js";

import { workerToolNames as agentWorkerToolNames } from "@nano-agents/agent-tools";
import { generateText, isStepCount } from "ai";
import { and, count, desc, eq, inArray, lt } from "drizzle-orm";
import type { Store } from "../db/client.js";
import type { getDb } from "../db/client.js";
import { keyFor } from "../keys/keys.js";
import { getModel } from "../model/get-model.js";
import { buildWorkerToolSet } from "../turn/tools/build-tools.js";
import type { ToolContext } from "../turn/tools/context.js";
import { appendEvent } from "./events.js";
import { publish } from "./stream.js";
import { createProfile, execStdin } from "../linux/linux.js";
import { agents, conversations, delegations, members, messages } from "../db/schema.js";
import { RoomCapacityError } from "./rooms.js";

/** Visible teammates from hire_subagent (hidden background workers do not count). */
export const MAX_TEAMMATES_PER_PARENT = 10;
/** Concurrent hidden worker rows when none are free to reuse. */
export const MAX_WORKERS_PER_PARENT = 10;
/** @deprecated Use MAX_TEAMMATES_PER_PARENT — workers use MAX_WORKERS_PER_PARENT. */
export const MAX_CHILDREN_PER_PARENT = MAX_TEAMMATES_PER_PARENT;
export const MAX_TEAM_DEPTH = 2;
export const MAX_ROOM_MEMBERS = 20;

/** Live model calls keyed by delegation so stop/redirect can cancel immediately. */
const activeWorkerRuns = new Map<string, AbortController>();
/** Serializes free-worker allocation so parallel tool calls cannot claim one row twice. */
const workerSpawnLocks = new Map<string, Promise<void>>();

async function withWorkerSpawnLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = workerSpawnLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  workerSpawnLocks.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (workerSpawnLocks.get(key) === current) workerSpawnLocks.delete(key);
  }
}

/** Returned when spawn_worker cannot insert or reuse a worker; tool layer maps this to { error }. */
export class WorkerCapacityError extends Error {
  readonly workers: { workerId: string; label: string; status: string }[];

  constructor(workers: { workerId: string; label: string; status: string }[], message: string) {
    super(message);
    this.name = "WorkerCapacityError";
    this.workers = workers;
  }
}

/**
 * Returns how deep an agent sits in the team tree (0 = top-level hire).
 * Why: unbounded spawn chains fork-bomb the room and blow the prompt budget.
 * Input: store, account id, agent id. Output: depth number.
 */
export async function teamDepth(store: Store, accountId: string, agentId: string): Promise<number> {
  let depth = 0;
  let current: string | null = agentId;
  while (current) {
    const [row] = await store
      .select({ parentId: agents.parentId })
      .from(agents)
      .where(and(eq(agents.id, current), eq(agents.accountId, accountId)));
    if (!row?.parentId) break;
    depth += 1;
    current = row.parentId;
    if (depth > MAX_TEAM_DEPTH) break;
  }
  return depth;
}

/**
 * Creates a child specialist owned by the calling agent.
 * Why: Grok chief-of-staff pattern — coordinator hires specialists instead of
 * forcing the user to hire+mention each one. Child inherits provider/model
 * unless overridden, joins the same room so handoffs stay visible.
 * Input: store, account/room/caller ids, label/description/provider/modelId.
 * Output: the child agent + membership row. Throws on caps or room-full.
 */
/**
 * Creates a child specialist owned by the calling agent.
 * Why: Grok chief-of-staff pattern — coordinator hires specialists instead of
 * forcing the user to hire+mention each one. Child inherits provider/model
 * unless overridden, joins the same room so handoffs stay visible.
 * Input: store, account/room/caller ids, label/role/personality/job (+provider/model).
 * Output: the child agent + membership row. Throws on caps or room-full.
 */
export async function hireSubagent(
  store: Store,
  input: { accountId: string; conversationId: string; parentAgentId: string; teamId?: string } & {
    label: string;
    role: string;
    personality?: string;
    jobDescription: string;
    provider?: string;
    modelId?: string;
  },
) {
  const data = subagentCreateSchema.parse({
    label: input.label,
    role: input.role,
    personality: input.personality,
    jobDescription: input.jobDescription,
    provider: input.provider,
    modelId: input.modelId,
  });
  const [parent] = await store
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.parentAgentId), eq(agents.accountId, input.accountId)));
  if (!parent) throw new Error("Parent agent not found.");
  const depth = await teamDepth(store, input.accountId, input.parentAgentId);
  if (depth >= MAX_TEAM_DEPTH) throw new Error("Subagents cannot hire their own subagents beyond depth 2.");
  const [teammateCount] = await store
    .select({ value: count() })
    .from(agents)
    .where(
      and(eq(agents.parentId, input.parentAgentId), eq(agents.accountId, input.accountId), eq(agents.hidden, false)),
    );
  if ((teammateCount?.value ?? 0) >= MAX_TEAMMATES_PER_PARENT) {
    throw new Error(`This agent already has ${MAX_TEAMMATES_PER_PARENT} teammates. Background workers do not count toward that cap.`);
  }
  const [room] = await store
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)));
  if (!room) throw new Error("Room not found.");
  // Room integrity (Phase 15): a private chat stays 1:1 — nobody is ever
  // added to it, by tool or otherwise. Teams form in groups the agent creates
  // with create_group. The message names the way out instead of just refusing.
  if (room.kind === "direct") {
    throw new Error("Private chats stay 1:1 — create a group first with create_group, then hire there.");
  }
  const existing = await store
    .select({ agentId: members.agentId })
    .from(members)
    .where(and(eq(members.conversationId, input.conversationId), eq(members.accountId, input.accountId)));
  if (existing.length >= MAX_ROOM_MEMBERS) throw new RoomCapacityError();

  const baseName = data.label.trim().replace(/\s+/g, "-").slice(0, 60) || "subagent";
  const [child] = await store
    .insert(agents)
    .values({
      accountId: input.accountId,
      name: `${baseName}-${Math.random().toString(36).slice(2, 6)}`,
      label: data.label,
      role: data.role,
      personality: data.personality ?? "",
      jobDescription: data.jobDescription,
      provider: data.provider ?? parent.provider,
      modelId: data.modelId ?? parent.modelId,
      parentId: input.parentAgentId,
      teamId: input.teamId ?? parent.teamId ?? parent.id,
    })
    .returning();
  if (!child) throw new Error("Subagent insert returned no row.");
  await store.insert(members).values({ conversationId: input.conversationId, accountId: input.accountId, agentId: child.id });
  return child;
}

/**
 * Records a delegation from parent to an existing team agent.
 * Why: attribution table lets the UI show "via @chief" and lets audits trace
 * who asked for what; status flips to done/failed by the turn runner.
 * Input: store, account/room/parent ids, child agentId, task text.
 * Output: delegation row. Throws when child is outside account or self.
 */
export async function recordDelegation(
  store: Store,
  input: { accountId: string; conversationId: string; parentAgentId: string; agentId: string; task: string },
) {
  const data = delegateSchema.parse({ agentId: input.agentId, task: input.task });
  if (data.agentId === input.parentAgentId) throw new Error("An agent cannot delegate to itself.");
  const [child] = await store
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, data.agentId), eq(agents.accountId, input.accountId)));
  if (!child) throw new Error("Delegate target is not on this account.");
  const [membership] = await store
    .select({ agentId: members.agentId })
    .from(members)
    .where(
      and(
        eq(members.conversationId, input.conversationId),
        eq(members.accountId, input.accountId),
        eq(members.agentId, data.agentId),
      ),
    );
  if (!membership) throw new Error("Delegate target is not in this room.");
  const [row] = await store
    .insert(delegations)
    .values({
      accountId: input.accountId,
      parentAgentId: input.parentAgentId,
      childAgentId: data.agentId,
      conversationId: input.conversationId,
      task: data.task,
      status: "running",
    })
    .returning();
  if (!row) throw new Error("Delegation insert returned no row.");
  return row;
}

/**
 * Lists agents sharing the caller's team (same teamId or direct children).
 * Why: the model needs a small roster to choose delegates without dumping
 * the whole account roster into the prompt. Role rides along so the CMO
 * picks the social manager vs the researcher by job, not just name.
 * Input: store, account id, agent id. Output: team agents (id, name, label, role).
 */
export async function listTeam(store: Store, accountId: string, agentId: string) {
  const [self] = await store
    .select({ teamId: agents.teamId, id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  if (!self) return [];
  if (!self.teamId) {
    return store
      .select({ id: agents.id, name: agents.name, label: agents.label, role: agents.role })
      .from(agents)
      .where(
        and(eq(agents.parentId, agentId), eq(agents.accountId, accountId), eq(agents.hidden, false)),
      );
  }
  return store
    .select({ id: agents.id, name: agents.name, label: agents.label, role: agents.role })
    .from(agents)
    .where(and(eq(agents.teamId, self.teamId), eq(agents.accountId, accountId), eq(agents.hidden, false)));
}

/**
 * Adds an existing account agent to a group room (model-callable).
 * Why: teams grow after creation — CMO hires a designer next week without a
 * human console step. Group-only by construction: direct rooms throw the same
 * 1:1 message as hire/add paths, so no tool can ever touch a private chat.
 * Input: store, account/room/agent ids. Output: the membership row.
 */
export async function addGroupMember(
  store: Store,
  input: { accountId: string; conversationId: string; agentId: string },
) {
  const [room] = await store
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)));
  if (!room) throw new Error("Room not found.");
  if (room.kind === "direct") {
    throw new Error("Private chats stay 1:1 — create a group first with create_group, then hire there.");
  }
  const [agent] = await store
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.accountId, input.accountId)));
  if (!agent) throw new Error("Unknown agent id — invite only agents on this account.");
  const existing = await store
    .select({ agentId: members.agentId })
    .from(members)
    .where(and(eq(members.conversationId, input.conversationId), eq(members.accountId, input.accountId)));
  if (existing.some((row) => row.agentId === input.agentId)) return { agentId: input.agentId };
  if (existing.length >= MAX_ROOM_MEMBERS) throw new RoomCapacityError();
  const [row] = await store
    .insert(members)
    .values({ conversationId: input.conversationId, accountId: input.accountId, agentId: input.agentId })
    .returning();
  if (!row) throw new Error("The member insert returned no row.");
  return row;
}

const WORKER_RESULT_MAX = 20_000;
const WORKER_STEPS = 10;
export const WORKER_STALE_MS = 4 * 60 * 60 * 1000;

async function latestDelegationStatus(
  store: Store,
  accountId: string,
  workerId: string,
): Promise<"running" | "done" | "failed" | "none"> {
  const [row] = await store
    .select({ status: delegations.status })
    .from(delegations)
    .where(and(eq(delegations.childAgentId, workerId), eq(delegations.accountId, accountId)))
    .orderBy(desc(delegations.createdAt))
    .limit(1);
  if (!row) return "none";
  return row.status as "running" | "done" | "failed";
}

/** Free worker = hidden child whose latest delegation is not running (done, failed, or never run). */
async function findFreeHiddenWorker(store: Store, accountId: string, parentAgentId: string) {
  const hidden = await store
    .select({ id: agents.id, createdAt: agents.createdAt })
    .from(agents)
    .where(and(eq(agents.parentId, parentAgentId), eq(agents.accountId, accountId), eq(agents.hidden, true)))
    .orderBy(agents.createdAt);
  for (const row of hidden) {
    const status = await latestDelegationStatus(store, accountId, row.id);
    if (status !== "running") return row.id;
  }
  return null;
}

async function workerCapacitySnapshot(store: Store, accountId: string, parentAgentId: string) {
  const hidden = await store
    .select({ id: agents.id, label: agents.label })
    .from(agents)
    .where(and(eq(agents.parentId, parentAgentId), eq(agents.accountId, accountId), eq(agents.hidden, true)));
  const workers: { workerId: string; label: string; status: string }[] = [];
  for (const child of hidden) {
    const status = await latestDelegationStatus(store, accountId, child.id);
    workers.push({ workerId: child.id, label: child.label, status });
  }
  return workers;
}

async function throwWorkerCapacity(store: Store, accountId: string, parentAgentId: string): Promise<never> {
  const workers = await workerCapacitySnapshot(store, accountId, parentAgentId);
  const ids = workers.map((w) => `${w.workerId} (${w.label}, ${w.status})`).join("; ");
  throw new WorkerCapacityError(
    workers,
    `Worker limit (${MAX_WORKERS_PER_PARENT}) reached and every hidden worker is still running. ` +
      `Do not call spawn_worker again this turn — running results arrive on their own. Use stop_worker on a wedged id to free a slot. ` +
      `Finished workers are reused automatically on the next spawn_worker. Current worker ids: ${ids || "(none)"}`,
  );
}

async function assignWorkerRow(
  store: Store,
  input: {
    accountId: string;
    conversationId: string;
    parentAgentId: string;
    childAgentId: string;
    task: string;
    label: string;
    role: string;
    personality: string;
    jobDescription: string;
    provider: string;
    modelId: string;
  },
): Promise<{ workerId: string; delegationId: string; status: "running" }> {
  await store
    .update(agents)
    .set({
      label: input.label,
      role: input.role,
      personality: input.personality,
      jobDescription: input.jobDescription,
      provider: input.provider,
      modelId: input.modelId,
    })
    .where(and(eq(agents.id, input.childAgentId), eq(agents.accountId, input.accountId)));
  return startWorkerDelegation(store, {
    accountId: input.accountId,
    conversationId: input.conversationId,
    parentAgentId: input.parentAgentId,
    childAgentId: input.childAgentId,
    task: input.task,
  });
}

async function startWorkerDelegation(
  store: Store,
  input: {
    accountId: string;
    conversationId: string;
    parentAgentId: string;
    childAgentId: string;
    task: string;
  },
): Promise<{ workerId: string; delegationId: string; status: "running" }> {
  const [row] = await store
    .insert(delegations)
    .values({
      accountId: input.accountId,
      parentAgentId: input.parentAgentId,
      childAgentId: input.childAgentId,
      conversationId: input.conversationId,
      task: input.task,
      status: "running",
      progress: "Queued.",
    })
    .returning();
  if (!row) throw new Error("Delegation insert returned no row.");
  return { workerId: input.childAgentId, delegationId: row.id, status: "running" };
}

/**
 * Spawns an ephemeral background worker for the calling agent.
 * Why: the parent stays chatty while long work runs privately — the user can
 * keep asking things and gets a process id instead of silence. Hidden from
 * the roster and NOT a room member: its only output is the delegation result
 * the parent summarizes. Returns immediately; the work runs detached.
 * Input: store, account/room/caller ids, label/role/personality/job/task (+provider/model).
 * Output: {workerId, delegationId, status:"running"}. The run starts detached.
 */
export async function spawnWorker(
  store: Store,
  input: { accountId: string; conversationId: string; parentAgentId: string } & {
    label: string;
    role: string;
    personality?: string;
    jobDescription: string;
    task: string;
    kind?: WorkerKind;
    instructions?: string;
    provider?: string;
    modelId?: string;
  },
): Promise<{ workerId: string; delegationId: string; status: "running" }> {
  const data = spawnWorkerInputSchema.parse({
    label: input.label,
    role: input.role,
    personality: input.personality,
    jobDescription: input.jobDescription,
    task: input.task,
    kind: input.kind,
    instructions: input.instructions,
    provider: input.provider,
    modelId: input.modelId,
  });
  const [parent] = await store
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.parentAgentId), eq(agents.accountId, input.accountId)));
  if (!parent) throw new Error("Parent agent not found.");
  const depth = await teamDepth(store, input.accountId, input.parentAgentId);
  if (depth >= MAX_TEAM_DEPTH) throw new Error("Subagents cannot spawn their own workers beyond depth 2.");

  const packedJob = packWorkerJobDescription({
    kind: data.kind,
    jobDescription: data.jobDescription,
    instructions: data.instructions,
  });

  const workerMeta = {
    label: data.label,
    role: data.role,
    personality: data.personality ?? "",
    jobDescription: packedJob,
    provider: data.provider ?? parent.provider,
    modelId: data.modelId ?? parent.modelId,
  };

  return withWorkerSpawnLock(`${input.accountId}:${input.parentAgentId}`, async () => {
    const freeId = await findFreeHiddenWorker(store, input.accountId, input.parentAgentId);
    if (freeId) {
      return assignWorkerRow(store, {
        accountId: input.accountId,
        conversationId: input.conversationId,
        parentAgentId: input.parentAgentId,
        childAgentId: freeId,
        task: data.task,
        ...workerMeta,
      });
    }

    const [workerCount] = await store
      .select({ value: count() })
      .from(agents)
      .where(
        and(eq(agents.parentId, input.parentAgentId), eq(agents.accountId, input.accountId), eq(agents.hidden, true)),
      );
    if ((workerCount?.value ?? 0) >= MAX_WORKERS_PER_PARENT) {
      await throwWorkerCapacity(store, input.accountId, input.parentAgentId);
    }

    const baseName = data.label.trim().replace(/\s+/g, "-").slice(0, 60) || "worker";
    const [child] = await store
      .insert(agents)
      .values({
        accountId: input.accountId,
        name: `${baseName}-${Math.random().toString(36).slice(2, 6)}`,
        label: data.label,
        role: data.role,
        personality: data.personality ?? "",
        jobDescription: packedJob,
        provider: data.provider ?? parent.provider,
        modelId: data.modelId ?? parent.modelId,
        parentId: input.parentAgentId,
        teamId: parent.teamId ?? parent.id,
        hidden: true,
      })
      .returning();
    if (!child) throw new Error("Worker insert returned no row.");
    // NOTE: no members insert — workers are never room members. Room 1:1
    // integrity holds structurally, and group threads stay free of worker noise.
    return startWorkerDelegation(store, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      parentAgentId: input.parentAgentId,
      childAgentId: child.id,
      task: data.task,
    });
  });
}

/**
 * Reads a worker's latest delegation.
 * Why: server-side status read for capacity messages and the (non-model)
 * status path — the model never polls this; finished results arrive via
 * worker.settled → delivery, failures via parent re-wake.
 * Input: store, account id, worker agent id. Output: {status, task, result?}.
 */
export async function checkWorker(store: Store, accountId: string, workerId: string) {
  const id = workerRefSchema.parse({ workerId }).workerId;
  const [row] = await store
    .select()
    .from(delegations)
    .where(and(eq(delegations.childAgentId, id), eq(delegations.accountId, accountId)))
    .orderBy(desc(delegations.createdAt))
    .limit(1);
  if (!row) throw new Error("No work found for that worker id.");
  return { workerId: id, status: row.status, task: row.task, result: row.result };
}

/**
 * Stops a worker's running delegation.
 * Why: wedged or obsolete work should die on request instead of burning
 * budget until reclaim. Marks failed with the reason; the worker becomes free
 * for reuse on the next spawn_worker. Idempotent: nothing running reads as stopped.
 * Input: store, account id, worker agent id. Output: {stopped} flag.
 */
export async function stopWorker(store: Store, accountId: string, workerId: string): Promise<{ stopped: boolean }> {
  const id = workerRefSchema.parse({ workerId }).workerId;
  const [row] = await store
    .select({ id: delegations.id })
    .from(delegations)
    .where(and(eq(delegations.childAgentId, id), eq(delegations.accountId, accountId), eq(delegations.status, "running")))
    .orderBy(desc(delegations.createdAt))
    .limit(1);
  if (!row) return { stopped: false };
  const stopped = await store
    .update(delegations)
    .set({ status: "failed", result: "Stopped by the parent agent.", progress: "Stopped by manager." })
    .where(and(eq(delegations.id, row.id), eq(delegations.status, "running")))
    .returning({ id: delegations.id });
  if (stopped.length === 0) return { stopped: false };
  activeWorkerRuns.get(row.id)?.abort("Worker stopped by parent.");
  return { stopped: true };
}

/**
 * Reclaims workers lost to a core crash or hang.
 * Why: detached work that never reports would read "running" forever and the
 * parent would poll pointlessly. Stale threshold is generous (4h) because
 * workers legitimately run long.
 * Input: store, staleness ms. Output: the reclaimed rows.
 */
export async function reclaimStaleDelegations(store: Store, staleMs = WORKER_STALE_MS) {
  const cutoff = new Date(Date.now() - staleMs);
  const stale = await store
    .select()
    .from(delegations)
    .where(and(eq(delegations.status, "running"), lt(delegations.heartbeatAt, cutoff)));
  for (const row of stale) {
    const reclaimed = await store
      .update(delegations)
      .set({
        status: "failed",
        result: "Worker lost (core restarted or hung) and was reclaimed.",
        progress: "Reclaimed after its heartbeat stopped.",
      })
      .where(and(eq(delegations.id, row.id), eq(delegations.status, "running")))
      .returning({ id: delegations.id });
    if (reclaimed.length > 0) activeWorkerRuns.get(row.id)?.abort("Worker heartbeat expired.");
  }
  return stale;
}

export type WorkerGenerate = () => Promise<string>;

export type WorkerSettled = { workerId: string; task: string; result: string; status: "done" | "failed" };

/**
 * Counts this parent's failed workers.
 * Why: spawn_worker retries must stop after 2 failures — otherwise the model
 * loops workers forever on a wedged task. We check failures within a recent time window
 * (e.g. 5 minutes) as well as since the last human message.
 * This prevents a situation where a quick user correction ("I mean htop")
 * resets the failure counter to 0 and gives the agent 2 fresh attempts when the
 * underlying environment (e.g. no root/sudo password required) hasn't changed.
 * Input: store, account/room/parent ids. Output: failed delegation count.
 */
export async function failuresSinceLastUser(
  store: Store,
  accountId: string,
  conversationId: string,
  parentAgentId: string,
  windowMs = 5 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - windowMs);
  const full = await store
    .select({ agentId: messages.agentId, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)))
    .orderBy(desc(messages.createdAt))
    .limit(50);
  const lastHuman = full.find((row) => row.agentId === null)?.createdAt ?? null;
  const failed = await store
    .select({ createdAt: delegations.createdAt })
    .from(delegations)
    .where(
      and(
        eq(delegations.accountId, accountId),
        eq(delegations.conversationId, conversationId),
        eq(delegations.parentAgentId, parentAgentId),
        eq(delegations.status, "failed"),
      ),
    );
  const recentWindowFailures = failed.filter(
    (row) => row.createdAt && row.createdAt.getTime() > cutoff.getTime(),
  ).length;
  const sinceHuman = lastHuman
    ? failed.filter((row) => row.createdAt && row.createdAt.getTime() > lastHuman.getTime()).length
    : failed.length;

  return Math.max(recentWindowFailures, sinceHuman);
}

/**
 * Builds the hidden cue that rewakes the parent after a worker settles failed.
 * Why: the parent turn already ended, so nobody watches the delegation. Retry
 * once with a rewritten task; after 2 failures tell the person and stop.
 * Supports batched settled workers to wake the parent once instead of per-worker cascades.
 * Input: worker/task/result or array + retry flag. Output: cue string.
 */
export function workerFollowupCue(input: {
  workerId?: string;
  task?: string;
  result?: string;
  retry: boolean;
  settled?: Array<{ workerId: string; task: string; result: string }>;
}): string {
  if (input.settled && input.settled.length > 1) {
    const list = input.settled
      .map((s) => `Worker ${s.workerId} did not finish "${s.task.slice(0, 200)}". Result: ${s.result.slice(0, 400)}.`)
      .join("\n");
    if (input.retry) {
      return `${list}\n\nsend_message one short sentence about what happened and the next step you are taking, then spawn_worker once with a narrower task. Do not stop after the failure, and never send an internal line like "The worker finished with no output."`;
    }
    return `${list}\n\nsend_message what went wrong and what the person can do next. Do not spawn another worker. Never send an internal status line.`;
  }
  const workerId = input.workerId ?? input.settled?.[0]?.workerId ?? "worker";
  const task = input.task ?? input.settled?.[0]?.task ?? "task";
  const result = input.result ?? input.settled?.[0]?.result ?? "failed";
  const head = `Worker ${workerId} did not finish "${task.slice(0, 500)}". Result: ${result.slice(0, 1000)}.`;
  if (input.retry) {
    return `${head} send_message one short sentence about what happened and the next step you are taking, then spawn_worker once with a narrower task. Do not stop after the failure, and never send an internal line like "The worker finished with no output."`;
  }
  return `${head} send_message what went wrong and the one thing the person can do next. Do not spawn another worker. Never send an internal status line.`;
}

/**
 * Claims a delegation's one terminal auto-delivery exactly once.
 * Why: the spawn path schedules a delayed re-wake, and restarts or retries
 * could schedule another — without a guard the room gets the same summary
 * twice. Single atomic UPDATE ... WHERE delivered=false: exactly one claimer
 * gets true, every later claim gets false.
 * Input: store, delegation id. Output: true when this caller won delivery.
 */
export async function claimDelivery(store: Store, delegationId: string): Promise<boolean> {
  const claimed = await store
    .update(delegations)
    .set({ delivered: true })
    .where(
      and(
        eq(delegations.id, delegationId),
        inArray(delegations.status, ["done", "failed"]),
        eq(delegations.delivered, false),
      ),
    )
    .returning({ id: delegations.id });
  return claimed.length > 0;
}

/**
 * Checks whether a worker result already reached the room in the parent's voice.
 * Why: the auto-delivery re-wake races a person asking "any update?" — the
 * parent then summarizes from history in a live turn, and the delayed
 * auto-post would repeat it. Distinctive-head match on recent parent bubbles
 * catches the common double without a migration or fuzzy search.
 * Input: store, account/room/parent ids, worker result. Output: true when the
 * head of the result already appears in a recent parent message.
 */
export async function alreadyDelivered(
  store: Store,
  input: { accountId: string; conversationId: string; parentAgentId: string; result: string },
): Promise<boolean> {
  const head = input.result.trim().slice(0, 80);
  if (head.length < 20) return false;
  const recent = await store
    .select({ body: messages.body })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, input.conversationId),
        eq(messages.accountId, input.accountId),
        eq(messages.agentId, input.parentAgentId),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(20);
  return recent.some((row) => row.body.includes(head));
}

/**
 * Runs one worker to completion in the background (never throws).
 * Why: detached from any HTTP request or turn — the parent got its process
 * id at spawn and is re-woken on settle. Isolated brief only: standing method
 * plus the task, never the parent's thread — the parent keeps all context and
 * decides with the worker's reported proof. Restricted tools
 * (files/shell/desktop/web/history/skills, no voice/team/notify) so workers
 * cannot recurse or contact the user. Result lands truncated on the
 * delegation row for the parent to summarize.
 * Input: db, ids, task, skills root, optional stub generate (tests).
 * Output: nothing (all outcomes recorded). Never rejects.
 */
export async function runWorker(
  db: ReturnType<typeof getDb>,
  input: {
    accountId: string;
    conversationId: string;
    parentAgentId: string;
    childId: string;
    delegationId: string;
    task: string;
    skillsRoot?: string;
    generate?: WorkerGenerate;
    onSettled?: (settled: WorkerSettled) => void;
  },
): Promise<void> {
  const controller = new AbortController();
  activeWorkerRuns.set(input.delegationId, controller);
  type Usage = {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    reasoningTokens?: number | null;
    modelSteps?: number;
  };
  const finish = async (status: "done" | "failed", result: string, usage?: Usage): Promise<void> => {
    const { formatWorkerReport } = await import("../turn/worker-report.js");
    const fullReport = formatWorkerReport(result, status);
    const report = await compactWorkerReport(input.accountId, input.delegationId, fullReport);
    const updated = await db
      .update(delegations)
      .set({
        status,
        result: report.slice(0, WORKER_RESULT_MAX),
        progress: status === "done" ? "Completed." : "Stopped with a blocker.",
        heartbeatAt: new Date(),
        ...(usage?.inputTokens ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens ? { outputTokens: usage.outputTokens } : {}),
        ...(usage?.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage?.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        ...(usage?.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage?.modelSteps ? { modelSteps: usage.modelSteps } : {}),
      })
      .where(and(eq(delegations.id, input.delegationId), eq(delegations.status, "running")))
      .returning({ id: delegations.id })
      .catch(() => {});
    if (!Array.isArray(updated) || updated.length === 0) return;
    try {
      input.onSettled?.({ workerId: input.childId, task: input.task, result: report, status });
    } catch {
      // Listener is best-effort (scheduler re-wake); never fail the worker on it.
    }
  };
  try {
    const [delegation] = await db
      .select({ status: delegations.status })
      .from(delegations)
      .where(and(eq(delegations.id, input.delegationId), eq(delegations.accountId, input.accountId)));
    if (!delegation || delegation.status !== "running") return;
    const [child] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.childId), eq(agents.accountId, input.accountId)));
    if (!child) {
      await finish("failed", "Worker agent is gone.");
      return;
    }
    if (input.generate) {
      await finish("done", await input.generate());
      return;
    }
    // The person's computer is the chatting agent's screen. A hidden worker
    // must drive that same desktop, or Chrome opens on a screen they cannot see.
    const [parent] = await db
      .select({ linuxProfile: agents.linuxProfile })
      .from(agents)
      .where(and(eq(agents.id, input.parentAgentId), eq(agents.accountId, input.accountId)));
    let profile: string | null = parent?.linuxProfile ?? null;
    try {
      // Always re-ensure the profile: durable accounts may still be running an
      // older container created before toolchain/admin provisioning existed.
      profile = await createProfile(db, input.accountId, input.parentAgentId);
    } catch {
      // Read/search-only workers can still proceed if computer repair failed.
    }
    // Isolated brief: the worker gets its standing method (preamble), a
    // one-line role, and the task — nothing else. No parent identity, no
    // thread history: anything the worker needs must be in the brief. The
    // parent keeps all context and decides with the worker's reported proof.
    const credential = await keyFor(db, input.accountId, child.provider);
    const review: ToolContext = {
      db,
      store: db,
      accountId: input.accountId,
      conversationId: input.conversationId,
      agentId: input.childId,
      runId: input.delegationId,
      nextTime: () => new Date(),
      emittedMessages: [],
      emit: async (event) => {
        try {
          const row = await appendEvent(db, {
            accountId: input.accountId,
            conversationId: input.conversationId,
            runId: null,
            event,
          });
          publish(input.accountId, input.conversationId, { ...event, cursor: row.id });
        } catch {
          publish(input.accountId, input.conversationId, event);
        }
      },
      linuxProfile: profile,
      voiceAgentId: input.parentAgentId,
    };
    const tools = buildWorkerToolSet({
      db,
      accountId: input.accountId,
      conversationId: input.conversationId,
      profile,
      skillsRoot: input.skillsRoot,
      review,
    });
    const roleLine = `You are ${child.label} — ${child.role}.`;
    const kindMeta = unpackWorkerJobDescription(child.jobDescription);
    const standing = workerPreambleFor(kindMeta.kind, kindMeta.instructions);
    // Worker runs were a black box: dispatcher steps land in the trace log but
    // worker steps never did. Emit a worker session so failures and loops are
    // debuggable the same way (and a future transcript view can read them).
    const { ensureTracePlugins } = await import("../turn/trace/bootstrap.js");
    const { createTraceSession } = await import("../turn/trace/plugins.js");
    const { randomUUID: workerTraceUuid } = await import("node:crypto");
    ensureTracePlugins();
    const workerTrace = createTraceSession({
      traceId: workerTraceUuid(),
      runId: input.delegationId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      agentId: input.childId,
      mode: "worker",
      provider: child.provider,
      modelId: child.modelId,
      delegationId: input.delegationId,
    });
    const workerInstructions = `${standing}\n\n${roleLine}\n\nTask: ${input.task}`;
    await db
      .update(delegations)
      .set({ progress: "Working.", heartbeatAt: new Date() })
      .where(and(eq(delegations.id, input.delegationId), eq(delegations.status, "running")));
    await workerTrace.emit({
      type: "run.start",
      prefix: workerInstructions,
      tail: input.task,
      promptCacheKey: `${input.accountId}:${input.childId}`,
      toolNames: Object.keys(tools).sort(),
      instructions: [{ role: "system" as const, content: workerInstructions }],
      modelMessages: [{ role: "user", content: input.task }],
    });
    let workerSteps = 0;
    let shouldEarlyStop = false;
    let lastToolCallSignature = "";
    let duplicateCallCount = 0;
    // Shell workers do focused commands/installs — 5 steps is plenty; other kinds get WORKER_STEPS (10).
    const maxSteps = kindMeta.kind === "shell" ? 5 : WORKER_STEPS;
    const result = await generateText({
      model: getModel(child.provider, child.modelId, credential.apiKey, credential.baseUrl),
      abortSignal: controller.signal,
      instructions: [{ role: "system" as const, content: workerInstructions }],
      messages: [{ role: "user", content: input.task }],
      tools,
      stopWhen: [
        isStepCount(maxSteps),
        () => shouldEarlyStop,
      ],
      onStepEnd: async (step) => {
        workerSteps += 1;
        // Loop detection: if identical tool call repeats consecutively
        const currentCalls = (step.toolCalls ?? []).map((call) => ({
          name: (call as { toolName?: string }).toolName,
          input: (call as { input?: unknown }).input ?? (call as { args?: unknown }).args,
        }));
        const callSig = JSON.stringify(currentCalls);
        if (callSig.length > 2 && callSig === lastToolCallSignature) {
          duplicateCallCount += 1;
          if (duplicateCallCount >= 2) {
            shouldEarlyStop = true;
          }
        } else {
          lastToolCallSignature = callSig;
          duplicateCallCount = 0;
        }
        const toolNames = currentCalls.map((call) => call.name).filter(Boolean).join(", ");
        const checkpoint = toolNames
          ? `Step ${workerSteps}: ${toolNames}`
          : `Step ${workerSteps}: ${(step.text ?? "reasoning").replace(/\s+/g, " ").trim().slice(0, 180)}`;
        await db
          .update(delegations)
          .set({ progress: checkpoint, heartbeatAt: new Date() })
          .where(and(eq(delegations.id, input.delegationId), eq(delegations.status, "running")))
          .catch(() => {});

        // Fatal blocker detection: stop early if unrecoverable permission/sudo error occurs
        for (const tr of (step as { toolResults?: unknown[] }).toolResults ?? []) {
          const res =
            (tr as { result?: unknown; output?: unknown }).result ??
            (tr as { result?: unknown; output?: unknown }).output;
          const textRes = typeof res === "string" ? res : JSON.stringify(res ?? "");
          if (/permission denied|sudo:\s*a password is required|is not in the sudoers file/i.test(textRes)) {
            shouldEarlyStop = true;
          }
        }

        const usage = step.usage
          ? {
              inputTokens: step.usage.inputTokens,
              outputTokens: step.usage.outputTokens,
              cacheReadTokens: step.usage.inputTokenDetails?.cacheReadTokens,
              reasoningTokens: step.usage.outputTokenDetails?.reasoningTokens,
            }
          : undefined;
        await workerTrace.emit({
          type: "model.step.finish",
          step: workerSteps,
          text: (step.text ?? "").slice(0, 300),
          usage,
          toolCalls: (step.toolCalls ?? []).map((call) => ({
            toolCallId: (call as { toolCallId?: string }).toolCallId ?? "",
            name: (call as { toolName?: string }).toolName ?? "unknown",
            input: ((call as { input?: unknown }).input ?? (call as { args?: unknown }).args ?? null) as unknown,
          })),
          toolResults: [],
        });
      },
    });
    await workerTrace.emit({
      type: "run.finish",
      text: result.text,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.inputTokenDetails?.cacheReadTokens,
        reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens,
      },
      steps: workerSteps,
    });
    const { classifyWorkerEnding, collectWorkerFallback, collectWorkerText } = await import("../turn/worker-report.js");
    const ranTools =
      (result.toolResults?.length ?? 0) > 0 ||
      (result.steps ?? []).some(
        (step) => ((step as { toolCalls?: unknown[] }).toolCalls?.length ?? 0) > 0 || (step.toolResults?.length ?? 0) > 0,
      );
    // Billable usage for this worker (AI SDK 7: result.usage already sums all
    // steps, screenshots included) — persisted on the delegation row so the
    // per-chat display matches the provider dashboard.
    const inDetails = result.usage.inputTokenDetails as
      | { cacheReadTokens?: number; cacheWriteTokens?: number }
      | undefined;
    const outDetails = result.usage.outputTokenDetails as { reasoningTokens?: number } | undefined;
    const usage = {
      inputTokens: result.usage.inputTokens ?? null,
      outputTokens: result.usage.outputTokens ?? null,
      cacheReadTokens: inDetails?.cacheReadTokens ?? null,
      cacheWriteTokens: inDetails?.cacheWriteTokens ?? null,
      reasoningTokens: outDetails?.reasoningTokens ?? null,
      modelSteps: result.steps?.length ?? null,
    };
    const text = collectWorkerText(result);
    const ending = classifyWorkerEnding(text, ranTools);
    if (ending.kind === "stall") {
      // The worker narrated a next step but never took it (weak model ended on a
      // text-only turn). Hand back a tool digest if any ran, else a clean
      // failure — never record the narration as a success the parent delivers.
      await finish(
        "failed",
        collectWorkerFallback(result) || "The task was not completed — the worker stopped before acting. No findings were returned.",
        usage,
      );
      return;
    }
    // report | needs_person: deliver as-is (needs_person triggers the sign-in handover).
    await finish("done", ending.result, usage);
  } catch (error) {
    await finish("failed", error instanceof Error ? error.message : "The worker failed.");
  } finally {
    if (activeWorkerRuns.get(input.delegationId) === controller) {
      activeWorkerRuns.delete(input.delegationId);
    }
  }
}

/**
 * Keeps large datasets/logs out of manager context while preserving every byte.
 * Workers are prompted to do this themselves; this is the deterministic safety
 * net for models that still paste a long report.
 */
async function compactWorkerReport(accountId: string, delegationId: string, report: string): Promise<string> {
  const REPORT_INLINE_MAX = 4_000;
  if (report.length <= REPORT_INLINE_MAX) return report;
  const path = `/shared/worker-results/${delegationId}.md`;
  const written = await execStdin(
    accountId,
    ["sh", "-c", `mkdir -p /shared/worker-results && cat > '${path}' && chmod 644 '${path}'`],
    Buffer.from(report, "utf8"),
  ).catch(() => null);
  if (!written || written.code !== 0) return report.slice(0, REPORT_INLINE_MAX);

  const head = report.slice(0, 2_800);
  const boundary = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf(". "), head.lastIndexOf("\n"));
  const summary = head.slice(0, boundary >= 1_400 ? boundary : head.length).trimEnd();
  return `${summary}\n\nFull report: ${path}`;
}

/**
 * Names a worker can call.
 * Why: tests lock the worker to the same computer tools as the chat, plus
 * the two recall tools a worker is allowed. Voice and team tools stay off.
 * Input: whether this worker has a Linux profile. Output: sorted names.
 */
export function workerToolNames(hasComputer: boolean): string[] {
  return agentWorkerToolNames(hasComputer);
}
