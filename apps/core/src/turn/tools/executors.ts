/**
 * Tool execute bodies for the dispatcher registry.
 * DB: per tool — messages, delegations, agents, routines, notifications.
 */
import {
  deleteRoutinesInputSchema,
  delegateSchema,
  groupConversationInputSchema,
  groupCreateInputSchema,
  notifyInputSchema,
  reactionSchema,
  routineCreateInputSchema,
  routineIdSchema,
  routineUpdateInputSchema,
  sendMessageInputSchema,
  spawnWorkerToolInputSchema,
  subagentCreateSchema,
  workerRedirectInputSchema,
} from "@nano-agents/agent-tools";
import { and, desc, eq } from "drizzle-orm";
import { agents, conversations, delegations, members } from "../../db/schema.js";
import { readHistory } from "../../memory/memory.js";
import { todoList, todoWrite } from "../../memory/todos.js";
import { saveNotification } from "../../notify/notify.js";
import { createGroupRoom, deleteGroupRoom, listGroupRoomsForAgent } from "../../rooms/rooms.js";
import { unpackWorkerJobDescription } from "../../rooms/worker-kinds.js";
import { saveSendMessage, saveReaction } from "../../rooms/send-message.js";
import {
  addGroupMember,
  failuresSinceLastUser,
  hireSubagent,
  listTeam,
  recordDelegation,
  runWorker,
  spawnWorker,
  stopWorker,
  WorkerCapacityError,
} from "../../rooms/subagents.js";
import { readSkillForAccount } from "../../skills/skills.js";
import {
  createOwnRoutine,
  deleteOwnRoutine,
  deleteOwnRoutines,
  listOwnRoutines,
  updateOwnRoutine,
} from "../../routines/routines.js";
import { emitTurnBus } from "../events/bus.js";
import { DELEGATE_SYNC_TIMEOUT_MS, MAX_DELEGATION_DEPTH } from "../constants.js";
import { normalizeSendMessageInput } from "./normalize-send-message.js";
import { validateWorkerTask } from "./worker-task.js";
import type { ToolContext } from "./context.js";
import { ZodError } from "zod";

export type ToolExecutor = (ctx: ToolContext, input: Record<string, unknown>) => Promise<unknown>;

export async function executeSendMessage(ctx: ToolContext, input: Record<string, unknown>) {
  let parsed: ReturnType<typeof sendMessageInputSchema.parse>;
  const normalized = normalizeSendMessageInput(input);
  try {
    parsed = sendMessageInputSchema.parse({
      blocks: normalized.blocks,
      replyTo: normalized.replyTo ?? null,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        error:
          'Invalid send_message blocks. Use blocks: [{ "kind": "text", "markdown": "your message" }]. Each block must include kind (text | image | code | file | widget).',
      };
    }
    throw error;
  }
  const textChars = parsed.blocks
    .filter((block) => block.kind === "text")
    .reduce((sum, block) => sum + block.markdown.length, 0);
  if (textChars > 1200) {
    return {
      error:
        "That text bubble is too long. Split into 1–3 short sentences (or a second send_message). Lead with the answer. Use markdown (bold, short lists, links) or a widget instead of an essay.",
    };
  }
  const asksSecret = parsed.blocks.some((block) => block.kind === "widget" && block.widget === "secret");
  const saved = await saveSendMessage(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    viaAgentId: ctx.viaAgentId ?? null,
    blocks: parsed.blocks,
    replyTo: parsed.replyTo,
    createdAt: ctx.nextTime(),
  });
  ctx.emittedMessages.push(saved);
  await ctx.emit({ type: "message", message: saved });
  if (asksSecret) ctx.endTurn = true;
  return { messageId: saved.id, ...(asksSecret ? { endedTurn: true } : {}) };
}

export async function executeReact(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = reactionSchema.parse(input);
  const { reaction } = await saveReaction(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    messageId: parsed.messageId,
    emoji: parsed.emoji,
  });
  await ctx.emit({ type: "reaction", reaction });
  return { ok: true };
}

export async function executeNotify(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = notifyInputSchema.parse({
    title: input.title,
    body: input.body,
    urgency: input.urgency ?? "info",
  });
  const note = await saveNotification(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    agentId: ctx.agentId,
    title: parsed.title,
    body: parsed.body,
    urgency: parsed.urgency,
  });
  await ctx.emit({ type: "notify", notification: note });
  return { notificationId: note.id };
}

export async function executeReadHistory(ctx: ToolContext, input: Record<string, unknown>) {
  const rows =
    typeof input.messageId === "string"
      ? await readHistory(ctx.store, ctx.accountId, ctx.conversationId, { messageId: input.messageId })
      : await readHistory(ctx.store, ctx.accountId, ctx.conversationId, { search: String(input.search ?? "") });
  return rows.map((r) => ({ id: r.id, body: r.body }));
}

export async function executeReadSkill(ctx: ToolContext, input: Record<string, unknown>) {
  if (!ctx.skillsRoot) return "No skills directory configured.";
  try {
    return readSkillForAccount(ctx.skillsRoot, ctx.accountId, String(input.name));
  } catch {
    return "Skill not found.";
  }
}

export async function executeHireSubagent(ctx: ToolContext, input: Record<string, unknown>) {
  let parsed: ReturnType<typeof subagentCreateSchema.parse>;
  try {
    parsed = subagentCreateSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      return { error: "Invalid hire_subagent input. Required: label, role, jobDescription." };
    }
    throw error;
  }

  const hireConversationId = parsed.conversationId ?? ctx.conversationId;
  const [currentRoom] = await ctx.store
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(and(eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId)));
  if (currentRoom?.kind === "direct" && !parsed.conversationId) {
    return {
      error:
        "Private chats stay 1:1. Call create_group with a title, then hire_subagent with conversationId set to the conversationId create_group returned.",
    };
  }
  if (parsed.conversationId) {
    const [target] = await ctx.store
      .select({ kind: conversations.kind })
      .from(conversations)
      .where(and(eq(conversations.id, parsed.conversationId), eq(conversations.accountId, ctx.accountId)));
    if (!target || target.kind !== "group") {
      return { error: "conversationId must be a group room id from create_group on this account." };
    }
    const [membership] = await ctx.store
      .select({ agentId: members.agentId })
      .from(members)
      .where(
        and(
          eq(members.conversationId, parsed.conversationId),
          eq(members.accountId, ctx.accountId),
          eq(members.agentId, ctx.agentId),
        ),
      );
    if (!membership) {
      return { error: "You must be a member of that group to hire there." };
    }
  }

  let child: Awaited<ReturnType<typeof hireSubagent>>;
  try {
    child = await hireSubagent(ctx.store, {
      accountId: ctx.accountId,
      conversationId: hireConversationId,
      parentAgentId: ctx.agentId,
      label: parsed.label,
      role: parsed.role,
      personality: parsed.personality,
      jobDescription: parsed.jobDescription,
      provider: parsed.provider,
      modelId: parsed.modelId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "hire_subagent failed.";
    return { error: message };
  }
  const card = await saveSendMessage(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    blocks: [{ kind: "widget", widget: "agent-card", props: { agentId: child.id, label: child.label, name: child.name } }],
    createdAt: ctx.nextTime(),
  });
  ctx.emittedMessages.push(card);
  await ctx.emit({ type: "message", message: card });
  return { agentId: child.id, name: child.name, hiredInConversationId: hireConversationId };
}

/** Delegate with sync timeout — use spawn_worker for longer work. */
export async function executeDelegate(
  ctx: ToolContext,
  input: Record<string, unknown>,
  runDelegatedTurn: (args: {
    accountId: string;
    conversationId: string;
    runId: string;
    parentAgentId: string;
    childAgentId: string;
    delegationId: string;
    task: string;
    skillsRoot?: string;
    nextTime: () => Date;
    emittedMessages: ToolContext["emittedMessages"];
    emit: ToolContext["emit"];
    delegationDepth: number;
    generate?: ToolContext["generate"];
  }) => Promise<Array<{ body: string }>>,
): Promise<unknown> {
  const parsed = delegateSchema.parse({ agentId: input.agentId, task: input.task });
  if ((ctx.delegationDepth ?? 0) >= MAX_DELEGATION_DEPTH) {
    throw new Error("Delegation is already two levels deep — do this part yourself.");
  }
  const row = await recordDelegation(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    parentAgentId: ctx.agentId,
    agentId: parsed.agentId,
    task: parsed.task,
  });
  const run = runDelegatedTurn({
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    parentAgentId: ctx.agentId,
    childAgentId: parsed.agentId,
    delegationId: row.id,
    task: parsed.task,
    skillsRoot: ctx.skillsRoot,
    nextTime: ctx.nextTime,
    emittedMessages: ctx.emittedMessages,
    emit: ctx.emit,
    delegationDepth: (ctx.delegationDepth ?? 0) + 1,
    generate: ctx.generate,
  });
  try {
    const bubbles = await Promise.race([
      run,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Delegate timed out — use spawn_worker to stay available.")), DELEGATE_SYNC_TIMEOUT_MS),
      ),
    ]);
    await ctx.db
      .update(delegations)
      .set({ status: "done", result: bubbles.map((bubble) => bubble.body).join("\n\n").slice(0, 20_000) })
      .where(eq(delegations.id, row.id));
    return { delegationId: row.id, bubbles: bubbles.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Delegation failed.";
    await ctx.db
      .update(delegations)
      .set({ status: "failed", result: message.slice(0, 20_000) })
      .where(eq(delegations.id, row.id))
      .catch(() => {});
    throw error;
  }
}

/** Max spawns per turn: validation failures count, so the model can't retry-burn. */
export const MAX_SPAWNS_PER_TURN = 3;

export async function executeSpawnWorker(ctx: ToolContext, input: Record<string, unknown>) {
  ctx.spawnCount = (ctx.spawnCount ?? 0) + 1;
  if (ctx.spawnCount > MAX_SPAWNS_PER_TURN) {
    return {
      error: "Already spawned several workers this turn. send_message what you started, then stop — results arrive on their own.",
    };
  }
  const failed = await failuresSinceLastUser(ctx.store, ctx.accountId, ctx.conversationId, ctx.agentId);
  if (failed >= 2) {
    return {
      error: "Two workers already failed since the person's last message. Do not start another. send_message what failed, in plain words, then stop.",
    };
  }
  const task = String(input.task ?? "");
  const valid = validateWorkerTask(task);
  if (!valid.ok) return { error: valid.hint };
  // De-dupe: same parent+room already running (near-)identical task — reuse it
  // instead of burning a second worker on the same question. Independent jobs
  // (different task heads) still run side by side.
  const taskHead = valid.task.trim().slice(0, 80).toLowerCase();
  if (taskHead.length >= 20) {
    const rows = await ctx.store
      .select({ childAgentId: delegations.childAgentId, task: delegations.task })
      .from(delegations)
      .where(
        and(
          eq(delegations.accountId, ctx.accountId),
          eq(delegations.conversationId, ctx.conversationId),
          eq(delegations.parentAgentId, ctx.agentId),
          eq(delegations.status, "running"),
        ),
      )
      .orderBy(desc(delegations.createdAt))
      .limit(5);
    const same = rows.find((row) => row.task.trim().slice(0, 80).toLowerCase() === taskHead);
    if (same) {
      return {
        error: `That job is already running as ${same.childAgentId} and its result will be delivered on its own. End the turn — do not spawn a duplicate.`,
        workerId: same.childAgentId,
      };
    }
  }
  const parsed = spawnWorkerToolInputSchema.parse({ ...input, task: valid.task });
  let spawned: Awaited<ReturnType<typeof spawnWorker>>;
  try {
    spawned = await spawnWorker(ctx.store, {
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      parentAgentId: ctx.agentId,
      label: parsed.label,
      role: parsed.role,
      personality: parsed.personality,
      jobDescription: parsed.jobDescription,
      task: parsed.task,
      kind: parsed.kind,
      instructions: parsed.instructions,
    });
  } catch (error) {
    if (error instanceof WorkerCapacityError) {
      return { error: error.message, workers: error.workers };
    }
    throw error;
  }
  launchDetachedWorker(ctx, spawned, parsed.task);
  return spawned;
}

/** Starts a spawned worker detached with settle fanout. Shared by spawn + redirect. */
function launchDetachedWorker(
  ctx: ToolContext,
  spawned: { workerId: string; delegationId: string },
  task: string,
): void {
  void runWorker(ctx.db, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    parentAgentId: ctx.agentId,
    childId: spawned.workerId,
    delegationId: spawned.delegationId,
    task,
    skillsRoot: ctx.skillsRoot,
    onSettled: (settled) => {
      void emitTurnBus({
        type: "worker.settled",
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        parentAgentId: ctx.agentId,
        delegationId: spawned.delegationId,
        skillsRoot: ctx.skillsRoot,
        workerId: settled.workerId,
        task: settled.task,
        result: settled.result,
        status: settled.status,
      });
    },
  });
}

/**
 * Steers a running worker without losing its context (pragmatic
 * MessageSubagent). Stops the current attempt and restarts the same hidden
 * worker row with the original brief plus the new instruction — no fresh
 * worker, no re-explaining the job. Finished workers report instead.
 */
export async function executeRedirectWorker(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = workerRedirectInputSchema.parse(input);
  const [running] = await ctx.store
    .select()
    .from(delegations)
    .where(
      and(
        eq(delegations.childAgentId, parsed.workerId),
        eq(delegations.accountId, ctx.accountId),
        eq(delegations.status, "running"),
      ),
    )
    .orderBy(desc(delegations.createdAt))
    .limit(1);
  if (!running) {
    const [latest] = await ctx.store
      .select({ status: delegations.status, result: delegations.result })
      .from(delegations)
      .where(and(eq(delegations.childAgentId, parsed.workerId), eq(delegations.accountId, ctx.accountId)))
      .orderBy(desc(delegations.createdAt))
      .limit(1);
    if (!latest) throw new Error("No work found for that worker id.");
    return {
      workerId: parsed.workerId,
      status: latest.status,
      result: typeof latest.result === "string" ? latest.result.slice(0, 800) : null,
      note: "That worker already finished — use what it returned instead of redirecting.",
    };
  }
  if (running.parentAgentId !== ctx.agentId) {
    throw new Error("That worker does not belong to you.");
  }
  ctx.spawnCount = (ctx.spawnCount ?? 0) + 1;
  if (ctx.spawnCount > MAX_SPAWNS_PER_TURN) {
    return {
      error: "Already spawned several workers this turn. send_message what you started, then stop — results arrive on their own.",
    };
  }
  const failed = await failuresSinceLastUser(ctx.store, ctx.accountId, ctx.conversationId, ctx.agentId);
  if (failed >= 2) {
    return {
      error: "Two workers already failed since the person's last message. Do not start another. send_message what failed, in plain words, then stop.",
    };
  }
  const [worker] = await ctx.store
    .select({
      label: agents.label,
      role: agents.role,
      personality: agents.personality,
      jobDescription: agents.jobDescription,
    })
    .from(agents)
    .where(and(eq(agents.id, parsed.workerId), eq(agents.accountId, ctx.accountId)));
  if (!worker) throw new Error("Worker agent is gone.");
  const brief =
    `${running.task}\n\nRedirect from parent (previous attempt stopped — continue from here, do not restart what is already done): ${parsed.instruction}`;
  await stopWorker(ctx.store, ctx.accountId, parsed.workerId);
  // Stopping frees the same hidden row, so the redirect continues as the same
  // worker id — context preserved via the carried-over brief.
  const kindMeta = unpackWorkerJobDescription(worker.jobDescription);
  const spawned = await spawnWorker(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    parentAgentId: ctx.agentId,
    label: worker.label,
    role: worker.role,
    personality: worker.personality,
    jobDescription: kindMeta.jobDescription,
    kind: kindMeta.kind,
    instructions: kindMeta.instructions,
    task: brief,
  });
  launchDetachedWorker(ctx, spawned, brief);
  return { ...spawned, redirected: true };
}

export const dispatcherExecutors: Record<string, ToolExecutor> = {
  send_message: executeSendMessage,
  react_to_message: executeReact,
  notify_user: executeNotify,
  read_history: executeReadHistory,
  read_skill: executeReadSkill,
  hire_subagent: executeHireSubagent,
  list_team: (ctx) => listTeam(ctx.store, ctx.accountId, ctx.agentId),
  add_to_group: (ctx, input) =>
    addGroupMember(ctx.store, { accountId: ctx.accountId, conversationId: ctx.conversationId, agentId: String(input.agentId) }),
  todo_write: (ctx, input) =>
    todoWrite(
      ctx.store,
      ctx.accountId,
      ctx.agentId,
      input.todos as { content: string; status: "pending" | "in_progress" | "completed" }[],
    ),
  todo_list: (ctx) => todoList(ctx.store, ctx.accountId, ctx.agentId),
  create_group: async (ctx, input) => {
    let parsed: ReturnType<typeof groupCreateInputSchema.parse>;
    try {
      parsed = groupCreateInputSchema.parse(input);
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          error:
            'Invalid create_group input. Required: { "title": "Group name" }. memberIds is optional (omit or []); use agent UUIDs from list_team, not names — add members later with add_to_group.',
        };
      }
      throw error;
    }
    const room = await createGroupRoom(ctx.store, {
      accountId: ctx.accountId,
      ownerAgentId: ctx.agentId,
      title: parsed.title,
      memberIds: parsed.memberIds,
    });
    return { conversationId: room.id, title: room.title, members: room.members.length };
  },
  spawn_worker: executeSpawnWorker,
  redirect_worker: executeRedirectWorker,
  stop_worker: (ctx, input) => stopWorker(ctx.store, ctx.accountId, String(input.workerId)),
  create_routine: async (ctx, input) => {
    const routine = await createOwnRoutine(ctx.store, {
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      body: String(input.body),
      cron: String(input.cron),
      timezone: typeof input.timezone === "string" ? input.timezone : "UTC",
    });
    return { routineId: routine.id, nextRunAt: routine.nextRunAt };
  },
  update_routine: async (ctx, input) => {
    const updated = await updateOwnRoutine(ctx.store, ctx.accountId, ctx.agentId, {
      routineId: String(input.routineId),
      body: input.body as string | undefined,
      cron: input.cron as string | undefined,
      timezone: input.timezone as string | undefined,
      paused: input.paused as boolean | undefined,
    });
    if (!updated) throw new Error("No routine of yours with that id.");
    return { routineId: updated.id, nextRunAt: updated.nextRunAt, paused: updated.paused };
  },
  delete_routine: async (ctx, input) => {
    const parsed = routineIdSchema.parse({ routineId: input.routineId });
    const deleted = await deleteOwnRoutine(ctx.store, ctx.accountId, ctx.agentId, parsed.routineId);
    if (!deleted) throw new Error("No routine of yours with that id.");
    return { deleted: true };
  },
  delete_routines: async (ctx, input) => {
    const parsed = deleteRoutinesInputSchema.parse(input);
    return deleteOwnRoutines(ctx.store, ctx.accountId, ctx.agentId, {
      all: parsed.all === true,
      routineIds: parsed.routineIds,
    });
  },
  list_routines: (ctx) => listOwnRoutines(ctx.store, ctx.accountId, ctx.agentId),
  list_groups: (ctx) => listGroupRoomsForAgent(ctx.store, ctx.accountId, ctx.agentId),
  delete_group: async (ctx, input) => {
    let parsed: ReturnType<typeof groupConversationInputSchema.parse>;
    try {
      parsed = groupConversationInputSchema.parse(input);
    } catch (error) {
      if (error instanceof ZodError) {
        return { error: 'Invalid delete_group input. Required: { "conversationId": "<group uuid from list_groups>" }.' };
      }
      throw error;
    }
    // Approval gate: deleting a group with its history is irreversible. The
    // model must ask the person first and re-call with confirmed:true — the
    // turn asking the question ends without deleting anything.
    if (parsed.confirmed !== true) {
      return {
        error:
          "Deleting a group is irreversible. First send_message what will be deleted and ask. Only re-call delete_group with confirmed:true after the person says yes.",
      };
    }
    try {
      return await deleteGroupRoom(ctx.db, {
        accountId: ctx.accountId,
        ownerAgentId: ctx.agentId,
        conversationId: parsed.conversationId,
        activeConversationId: ctx.conversationId,
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : "delete_group failed." };
    }
  },
};
