/**
 * Tool execute bodies for the dispatcher registry.
 * DB: per tool — messages, delegations, agents, routines, notifications.
 */
import {
  delegateSchema,
  groupCreateInputSchema,
  notifyInputSchema,
  reactionSchema,
  routineCreateInputSchema,
  routineIdSchema,
  routineUpdateInputSchema,
  sendMessageInputSchema,
  spawnWorkerInputSchema,
  subagentCreateSchema,
} from "@nano-agents/shared";
import { eq } from "drizzle-orm";
import { delegations } from "../../db/schema.js";
import { readHistory } from "../../memory/memory.js";
import { todoList, todoWrite } from "../../memory/todos.js";
import { saveNotification } from "../../notify/notify.js";
import { createGroupRoom } from "../../rooms/rooms.js";
import { saveSendMessage, saveReaction } from "../../rooms/send-message.js";
import {
  addGroupMember,
  checkWorker,
  failuresSinceLastUser,
  hireSubagent,
  listTeam,
  recordDelegation,
  runWorker,
  spawnWorker,
  stopWorker,
} from "../../rooms/subagents.js";
import { readSkillForAccount } from "../../skills/skills.js";
import { createOwnRoutine, deleteOwnRoutine, listOwnRoutines, updateOwnRoutine } from "../../routines/routines.js";
import { emitTurnBus } from "../events/bus.js";
import { DELEGATE_SYNC_TIMEOUT_MS, MAX_DELEGATION_DEPTH } from "../constants.js";
import { validateWorkerTask } from "./catalog.js";
import type { ToolContext } from "./context.js";

export type ToolExecutor = (ctx: ToolContext, input: Record<string, unknown>) => Promise<unknown>;

export async function executeSendMessage(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = sendMessageInputSchema.parse({
    blocks: input.blocks,
    replyTo: input.replyTo ?? null,
  });
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
  return { messageId: saved.id };
}

export async function executeReact(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = reactionSchema.parse(input);
  const saved = await saveReaction(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    messageId: parsed.messageId,
    emoji: parsed.emoji,
  });
  await ctx.emit({ type: "reaction", reaction: saved });
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
  const parsed = subagentCreateSchema.parse(input);
  const child = await hireSubagent(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    parentAgentId: ctx.agentId,
    label: parsed.label,
    role: parsed.role,
    personality: parsed.personality,
    jobDescription: parsed.jobDescription,
    provider: parsed.provider,
    modelId: parsed.modelId,
  });
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
  return { agentId: child.id, name: child.name };
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

export async function executeSpawnWorker(ctx: ToolContext, input: Record<string, unknown>) {
  const failed = await failuresSinceLastUser(ctx.store, ctx.accountId, ctx.conversationId, ctx.agentId);
  if (failed >= 2) {
    return {
      error: "Two workers already failed since the person's last message. Do not start another. send_message what failed, in plain words, then stop.",
    };
  }
  const task = String(input.task ?? "");
  const valid = validateWorkerTask(task);
  if (!valid.ok) return { error: valid.hint };
  const parsed = spawnWorkerInputSchema.parse(input);
  const spawned = await spawnWorker(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    parentAgentId: ctx.agentId,
    label: parsed.label,
    role: parsed.role,
    personality: parsed.personality,
    jobDescription: parsed.jobDescription,
    task: parsed.task,
    provider: parsed.provider,
    modelId: parsed.modelId,
  });
  void runWorker(ctx.db, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    parentAgentId: ctx.agentId,
    childId: spawned.workerId,
    delegationId: spawned.delegationId,
    task: parsed.task,
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
  return spawned;
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
    const parsed = groupCreateInputSchema.parse(input);
    const room = await createGroupRoom(ctx.store, {
      accountId: ctx.accountId,
      ownerAgentId: ctx.agentId,
      title: parsed.title,
      memberIds: parsed.memberIds,
    });
    return { conversationId: room.id, title: room.title, members: room.members.length };
  },
  spawn_worker: executeSpawnWorker,
  check_worker: (ctx, input) => checkWorker(ctx.store, ctx.accountId, String(input.workerId)),
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
  list_routines: (ctx) => listOwnRoutines(ctx.store, ctx.accountId, ctx.agentId),
};
