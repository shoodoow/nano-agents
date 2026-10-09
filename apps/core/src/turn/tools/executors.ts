/**
 * Tool execute bodies for the dispatcher registry.
 * DB: per tool — messages, delegations, agents, routines, notifications.
 */
import {
  deleteRoutinesInputSchema,
  correctMemoryToolInputSchema,
  delegateSchema,
  groupConversationInputSchema,
  groupCreateInputSchema,
  memberAddInputSchema,
  notifyInputSchema,
  reactionSchema,
  rememberFactToolInputSchema,
  routineCreateInputSchema,
  routineIdSchema,
  routineUpdateInputSchema,
  sendMessageInputSchema,
  spawnWorkerToolInputSchema,
  subagentCreateSchema,
  teammateUpdateSchema,
  workerRedirectInputSchema,
} from "@nano-agents/agent-tools";
import { takeOver } from "../../desktop/desktop.js";
import { and, desc, eq } from "drizzle-orm";
import { agents, conversations, delegations, members } from "../../db/schema.js";
import { correct, readHistory, remember } from "../../memory/memory.js";
import { embedSummaryBacklog } from "../../memory/recall.js";
import { todoList, todoWrite } from "../../memory/todos.js";
import { saveNotification } from "../../notify/notify.js";
import { createGroupRoom, deleteGroupRoom, listGroupRoomsForAgent } from "../../rooms/rooms.js";
import { inlineSharedOutputBlocks } from "../../rooms/uploads.js";
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
import { updateAgentFlags } from "../../roster/roster.js";
import { catalogTextForAgent, readSkillForAgent } from "../../skills/agent-skills.js";
import { bumpAccountPromptVersions } from "../../skills/install.js";
import {
  createOwnRoutine,
  deleteOwnRoutine,
  deleteOwnRoutines,
  listOwnRoutines,
  updateOwnRoutine,
} from "../../routines/routines.js";
import { emitTurnBus } from "../events/bus.js";
import { MAX_DELEGATION_DEPTH } from "../constants.js";
import { normalizeSendMessageInput } from "./normalize-send-message.js";
import { validateWorkerTask } from "./worker-task.js";
import type { ToolContext } from "./context.js";
import { ZodError } from "zod";

export type ToolExecutor = (ctx: ToolContext, input: Record<string, unknown>) => Promise<unknown>;

/**
 * Saves one durable fact backed by a message in the current room.
 * Why: long-lived employees need explicit, sourceable memory rather than
 * relying on an ever-growing transcript. Agent scope is bound to the caller.
 */
async function executeRememberFact(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = rememberFactToolInputSchema.parse(input);
  const source = await readHistory(ctx.db, ctx.accountId, ctx.conversationId, { messageId: parsed.messageId });
  if (source.length === 0) throw new Error("The memory source message is not in this room.");
  const saved = await remember(ctx.db, ctx.accountId, {
    ...parsed,
    agentId: parsed.scope === "agent" ? ctx.agentId : undefined,
  });
  await embedSummaryBacklog(ctx.db, ctx.accountId, ctx.conversationId).catch(() => {});
  return { memoryId: saved.id, scope: saved.scope, body: saved.body };
}

/**
 * Replaces an exact durable fact using a correcting message in this room.
 * Why: corrections must remove stale guidance instead of leaving two
 * contradictory memories for the employee to reconcile on every future turn.
 */
async function executeCorrectMemory(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = correctMemoryToolInputSchema.parse(input);
  const source = await readHistory(ctx.db, ctx.accountId, ctx.conversationId, { messageId: parsed.messageId });
  if (source.length === 0) throw new Error("The correction source message is not in this room.");
  const saved = await correct(ctx.db, ctx.accountId, {
    ...parsed,
    agentId: parsed.scope === "agent" ? ctx.agentId : undefined,
  });
  await embedSummaryBacklog(ctx.db, ctx.accountId, ctx.conversationId).catch(() => {});
  return { memoryId: saved.id, scope: saved.scope, body: saved.body };
}

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
  const asksDesktopHandover = parsed.blocks.some(
    (block) => block.kind === "widget" && block.widget === "desktop-handover",
  );
  if (asksDesktopHandover && ctx.linuxProfile) {
    takeOver(ctx.accountId, ctx.linuxProfile);
  }
  let deliverableBlocks = parsed.blocks;
  try {
    deliverableBlocks = await inlineSharedOutputBlocks(ctx.accountId, parsed.blocks);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not attach the shared file." };
  }
  const saved = await saveSendMessage(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    viaAgentId: ctx.viaAgentId ?? null,
    blocks: deliverableBlocks,
    replyTo: parsed.replyTo,
    createdAt: ctx.nextTime(),
  });
  ctx.emittedMessages.push(saved);
  await ctx.emit({ type: "message", message: saved });
  if (asksSecret || asksDesktopHandover) ctx.endTurn = true;
  return { messageId: saved.id, ...(asksSecret || asksDesktopHandover ? { endedTurn: true } : {}) };
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

function skillCtx(ctx: Pick<ToolContext, "skillsRoot" | "accountId" | "linuxProfile">) {
  return { skillsRoot: ctx.skillsRoot, accountId: ctx.accountId, linuxProfile: ctx.linuxProfile };
}

export async function executeReadSkill(ctx: ToolContext, input: Record<string, unknown>) {
  if (!ctx.skillsRoot && !ctx.linuxProfile) return "No skills directory configured.";
  try {
    return await readSkillForAgent(skillCtx(ctx), String(input.name));
  } catch {
    return "Skill not found.";
  }
}

export async function executeListSkills(ctx: Pick<ToolContext, "skillsRoot" | "accountId" | "linuxProfile">) {
  if (!ctx.skillsRoot && !ctx.linuxProfile) return "No skills directory configured.";
  const catalog = await catalogTextForAgent(skillCtx(ctx));
  return catalog || "No skills available yet.";
}

export async function executeRefreshSkills(
  ctx: Pick<ToolContext, "db" | "skillsRoot" | "accountId" | "linuxProfile">,
) {
  if (!ctx.skillsRoot && !ctx.linuxProfile) return "No skills directory configured.";
  const bumped = await bumpAccountPromptVersions(ctx.db, ctx.accountId);
  return { refreshed: true, agents: bumped, catalog: await catalogTextForAgent(skillCtx(ctx)) };
}

export async function executeUpdateTeammate(ctx: ToolContext, input: Record<string, unknown>) {
  let parsed: ReturnType<typeof teammateUpdateSchema.parse>;
  try {
    parsed = teammateUpdateSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      return { error: "Invalid update_teammate input. Required: agentId, plus label, role, personality, or jobDescription." };
    }
    throw error;
  }
  if (!parsed.label && !parsed.role && parsed.personality === undefined && !parsed.jobDescription) {
    return { error: "Pass label, role, personality, or jobDescription." };
  }
  const [target] = await ctx.store
    .select()
    .from(agents)
    .where(and(eq(agents.id, parsed.agentId), eq(agents.accountId, ctx.accountId)));
  if (!target || target.hidden) return { error: "That teammate is not on your team." };
  const mine = target.parentId === ctx.agentId || target.teamId === ctx.agentId;
  if (!mine || target.id === ctx.agentId) return { error: "You can only update a teammate you hired." };
  const patch: { name?: string; label?: string; role?: string; personality?: string; jobDescription?: string } = {};
  if (parsed.label) {
    const name = parsed.label.trim();
    const siblings = await ctx.store
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.accountId, ctx.accountId));
    if (siblings.some((row) => row.id !== target.id && row.name.toLowerCase() === name.toLowerCase())) {
      return { error: "Another agent already uses that name. Pick a different first name." };
    }
    patch.name = name;
    patch.label = name;
  }
  if (parsed.role) patch.role = parsed.role;
  if (parsed.personality !== undefined) patch.personality = parsed.personality;
  if (parsed.jobDescription) patch.jobDescription = parsed.jobDescription;
  const saved = await updateAgentFlags(ctx.store, ctx.accountId, target.id, patch);
  if (!saved) return { error: "That teammate is not on your team." };
  return { agentId: saved.id, name: saved.name, label: saved.label, role: saved.role };
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

/**
 * Starts a visible teammate turn without blocking the parent.
 * Why: a model call cannot reliably finish inside the old 2s race. That race
 * marked healthy teammate turns failed while their messages kept arriving.
 * Persistent teammates speak in the group; hidden workers remain parent-only.
 */
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
  const parsed = delegateSchema.parse({
    agentId: input.agentId,
    task: input.task,
    conversationId: input.conversationId,
  }) as { agentId: string; task: string; conversationId?: string };
  if ((ctx.delegationDepth ?? 0) >= MAX_DELEGATION_DEPTH) {
    throw new Error("Delegation is already two levels deep — do this part yourself.");
  }
  const target = await resolveGroupTarget(ctx, parsed.conversationId, "delegate", parsed.agentId);
  if ("error" in target) return target;
  const [inGroup] = await ctx.store
    .select({ agentId: members.agentId })
    .from(members)
    .where(
      and(
        eq(members.conversationId, target.conversationId),
        eq(members.accountId, ctx.accountId),
        eq(members.agentId, parsed.agentId),
      ),
    );
  if (!inGroup) {
    return {
      error: `That teammate is not in group id:${target.conversationId}. hire_subagent with that conversationId adds them — do not call add_to_group after hire. add_to_group is only for an existing teammate missing from the group.`,
    };
  }
  const row = await recordDelegation(ctx.store, {
    accountId: ctx.accountId,
    conversationId: target.conversationId,
    parentAgentId: ctx.agentId,
    agentId: parsed.agentId,
    task: parsed.task,
  });
  void runDelegatedTurn({
    accountId: ctx.accountId,
    conversationId: target.conversationId,
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
  })
    .then(async (bubbles) => {
      await ctx.db
        .update(delegations)
        .set({ status: "done", result: bubbles.map((bubble) => bubble.body).join("\n\n").slice(0, 20_000) })
        .where(eq(delegations.id, row.id));
    })
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : "Delegation failed.";
      await ctx.db
        .update(delegations)
        .set({ status: "failed", result: message.slice(0, 20_000) })
        .where(eq(delegations.id, row.id))
        .catch(() => {});
    });
  return { delegationId: row.id, status: "started", conversationId: target.conversationId };
}

/**
 * Picks the group a team tool should touch.
 * Why: a private-chat turn has no crew in the room. Explicit conversationId
 * wins; otherwise infer the sticky group (single owned group, or the one
 * containing the child) so the model is not forced to copy UUIDs. Generic:
 * works for any team purpose, not one example crew. No new tool, no new step.
 */
async function resolveGroupTarget(
  ctx: ToolContext,
  conversationId: string | undefined,
  tool: "delegate" | "add_to_group",
  childAgentId?: string,
): Promise<{ conversationId: string } | { error: string }> {
  if (conversationId) {
    const [room] = await ctx.store
      .select({ kind: conversations.kind })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, ctx.accountId)));
    if (!room || room.kind !== "group") {
      return { error: "conversationId must be a group id from Groups: in your prompt on this account." };
    }
    const [membership] = await ctx.store
      .select({ agentId: members.agentId })
      .from(members)
      .where(
        and(eq(members.conversationId, conversationId), eq(members.accountId, ctx.accountId), eq(members.agentId, ctx.agentId)),
      );
    if (!membership) return { error: "You must be a member of that group." };
    return { conversationId };
  }
  const [current] = await ctx.store
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(and(eq(conversations.id, ctx.conversationId), eq(conversations.accountId, ctx.accountId)));
  if (current?.kind !== "direct") {
    const targetId = ctx.conversationId;
    const [room] = await ctx.store
      .select({ kind: conversations.kind })
      .from(conversations)
      .where(and(eq(conversations.id, targetId), eq(conversations.accountId, ctx.accountId)));
    if (!room || room.kind !== "group") {
      return { error: "conversationId must be a group id from Groups: in your prompt on this account." };
    }
    const [membership] = await ctx.store
      .select({ agentId: members.agentId })
      .from(members)
      .where(
        and(eq(members.conversationId, targetId), eq(members.accountId, ctx.accountId), eq(members.agentId, ctx.agentId)),
      );
    if (!membership) return { error: "You must be a member of that group." };
    return { conversationId: targetId };
  }
  const { listGroupRoomsForAgent } = await import("../../rooms/rooms.js");
  const groups = await listGroupRoomsForAgent(ctx.store, ctx.accountId, ctx.agentId).catch(() => []);
  if (groups.length === 0) {
    return {
      error:
        tool === "delegate"
          ? "No group yet. Call create_group once with a title, then hire_subagent there, then delegate. Copy the group id from Groups: in your prompt."
          : "No group yet. Call create_group once, then hire_subagent there. Copy the group id from Groups: in your prompt.",
    };
  }
  if (groups.length === 1 && groups[0]) {
    return { conversationId: groups[0].conversationId };
  }
  if (childAgentId) {
    const containing: { conversationId: string; title: string; owned: boolean }[] = [];
    for (const group of groups) {
      const [hit] = await ctx.store
        .select({ agentId: members.agentId })
        .from(members)
        .where(
          and(
            eq(members.conversationId, group.conversationId),
            eq(members.accountId, ctx.accountId),
            eq(members.agentId, childAgentId),
          ),
        );
      if (hit) containing.push(group);
    }
    if (containing.length === 1 && containing[0]) {
      return { conversationId: containing[0].conversationId };
    }
    if (containing.length > 1) {
      const list = containing.map((group) => `"${group.title}" (id:${group.conversationId})`).join("; ");
      return { error: `That teammate is in several groups. Pass conversationId copied from Groups: — candidates: ${list}.` };
    }
  }
  const list = groups
    .slice(0, 5)
    .map((group) => `"${group.title}" (id:${group.conversationId})`)
    .join("; ");
  return {
    error: `You are in a private chat with several groups. Pass conversationId copied verbatim from Groups: in your prompt — candidates: ${list}. Do not create another group when one title already matches.`,
  };
}

export async function executeAddToGroup(ctx: ToolContext, input: Record<string, unknown>) {
  let parsed: { agentId: string; conversationId?: string };
  try {
    parsed = memberAddInputSchema.parse(input) as { agentId: string; conversationId?: string };
  } catch (error) {
    if (error instanceof ZodError) {
      return { error: "Invalid add_to_group input. Required: agentId (UUID). From a private chat also pass conversationId." };
    }
    throw error;
  }
  const target = await resolveGroupTarget(ctx, parsed.conversationId, "add_to_group", parsed.agentId);
  if ("error" in target) return target;
  try {
    const row = await addGroupMember(ctx.store, {
      accountId: ctx.accountId,
      conversationId: target.conversationId,
      agentId: parsed.agentId,
    });
    return { agentId: row.agentId, conversationId: target.conversationId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "add_to_group failed.";
    return { error: message };
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
  const task = String(input.task ?? "");
  const failed = await failuresSinceLastUser(ctx.store, ctx.accountId, ctx.conversationId, ctx.agentId, task);
  if (failed >= 2) {
    return {
      error:
        "Two workers already failed on this same task since the person's last message. A different task can still start. send_message what failed, in plain words, then stop.",
    };
  }
  const valid = validateWorkerTask(task);
  if (!valid.ok) return { error: valid.hint };
  // De-dupe: same parent+room already running (near-)identical task — reuse it
  // instead of burning a second worker on the same question. Independent jobs
  // (different task heads) still run side by side.
  const taskHead = valid.task.trim().slice(0, 80).toLowerCase();
  if (taskHead.length >= 5) {
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
    const same = rows.find((row) => {
      const rowHead = row.task.trim().slice(0, 80).toLowerCase();
      return rowHead === taskHead || (taskHead.length >= 10 && (rowHead.includes(taskHead) || taskHead.includes(rowHead)));
    });
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
      maxSteps: parsed.maxSteps,
    });
  } catch (error) {
    if (error instanceof WorkerCapacityError) {
      return { error: error.message, workers: error.workers };
    }
    throw error;
  }
  launchDetachedWorker(ctx, spawned, parsed.task, parsed.maxSteps);
  return spawned;
}

/** Starts a spawned worker detached with settle fanout. Shared by spawn + redirect. */
function launchDetachedWorker(
  ctx: ToolContext,
  spawned: { workerId: string; delegationId: string },
  task: string,
  maxSteps?: number,
): void {
  void runWorker(ctx.db, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    parentAgentId: ctx.agentId,
    childId: spawned.workerId,
    delegationId: spawned.delegationId,
    task,
    maxSteps,
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
  const failed = await failuresSinceLastUser(
    ctx.store,
    ctx.accountId,
    ctx.conversationId,
    ctx.agentId,
    running.task,
  );
  if (failed >= 2) {
    return {
      error:
        "Two workers already failed on this same task since the person's last message. A different task can still start. send_message what failed, in plain words, then stop.",
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
  remember_fact: executeRememberFact,
  correct_memory: executeCorrectMemory,
  read_skill: executeReadSkill,
  list_skills: (ctx) => executeListSkills(ctx),
  refresh_skills: (ctx) => executeRefreshSkills(ctx),
  hire_subagent: executeHireSubagent,
  update_teammate: executeUpdateTeammate,
  list_team: (ctx) => listTeam(ctx.store, ctx.accountId, ctx.agentId),
  add_to_group: executeAddToGroup,
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
      title: String(input.title),
      instructions: String(input.instructions),
      cron: String(input.cron),
      timezone: typeof input.timezone === "string" ? input.timezone : "UTC",
    });
    return { routineId: routine.id, title: routine.title, nextRunAt: routine.nextRunAt };
  },
  update_routine: async (ctx, input) => {
    const updated = await updateOwnRoutine(ctx.store, ctx.accountId, ctx.agentId, {
      routineId: String(input.routineId),
      title: input.title as string | undefined,
      instructions: input.instructions as string | undefined,
      cron: input.cron as string | undefined,
      timezone: input.timezone as string | undefined,
      paused: input.paused as boolean | undefined,
    });
    if (!updated) throw new Error("No routine of yours with that id.");
    return { routineId: updated.id, title: updated.title, nextRunAt: updated.nextRunAt, paused: updated.paused };
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
