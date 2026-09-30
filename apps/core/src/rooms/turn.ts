import { generateText, isStepCount, jsonSchema, tool, type ModelMessage, type SystemModelMessage } from "ai";
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
  workerRefSchema,
} from "@nano-agents/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import { buildContext, identityBlock } from "../memory/context.js";
import { traceError, tracePreview, tracePrompt, traceStep } from "../log/trace.js";
import { readHistory } from "../memory/memory.js";
import type { getDb, Store } from "../db/client.js";
import { agents, conversations, delegations, members, messages, summaryItems } from "../db/schema.js";
import { keyFor } from "../keys/keys.js";
import { getModel } from "../model/get-model.js";
import { speakers } from "./mentions.js";
import { claimQueuedForRoom, createGroupRoom, saveUserMessage } from "./rooms.js";
import { propose } from "../skills/proposals.js";
import { readSkillForAccount, skillCatalogForAccount } from "../skills/skills.js";
import { mergeSummary } from "../memory/summary.js";
import { listTools } from "../skills/tools.js";
import { profileToolNames } from "../computer/profile-tools.js";
import { createProfile } from "../linux/linux.js";
import { saveNotification } from "../notify/notify.js";
import { takeOver } from "../desktop/desktop.js";
import { todoList, todoWrite } from "../memory/todos.js";
import { createOwnRoutine, deleteOwnRoutine, listOwnRoutines, updateOwnRoutine } from "../routines/routines.js";
import { saveSendMessage, saveReaction, blocksToText, type TurnEvent } from "./send-message.js";
import { appendEvent } from "./events.js";
import { acquireRun, failRun, finishRun, heartbeatRun } from "./runs.js";
import { publish, type StreamEvent } from "./stream.js";
import { parseDataUri } from "./uploads.js";
import { addGroupMember, alreadyDelivered, checkWorker, claimDelivery, failuresSinceLastUser, hireSubagent, listTeam, recordDelegation, runWorker, spawnWorker, stopWorker, workerFollowupCue } from "./subagents.js";

type Db = ReturnType<typeof getDb>;

const HEARTBEAT_MS = 30_000;
// Delegation depth cap (Phase 15): parent 0 -> child 1 -> grandchild 2 stops.
// Bounds nested model calls so a delegation chain cannot recurse forever.
const MAX_DELEGATION_DEPTH = 2;
const DELEGATION_HISTORY_SLICE = 10;

export type TurnImagePart =
  // File parts carry data: URIs with an exact mime (AI SDK v7; "image" parts
  // are deprecated and warn). Remote https URLs keep the legacy image shape
  // because their mime is unknown without fetching.
  | { type: "file"; data: string; mediaType: string }
  | { type: "image"; image: string };

export type TurnMessageContent =
  | string
  | Array<{ type: "text"; text: string } | TurnImagePart>;

export type TurnInput = {
  agentId: string;
  provider: string;
  modelId: string;
  system: string;
  prefix: string;
  tail: string;
  promptCacheKey: string;
  messages: { role: "user" | "assistant"; content: TurnMessageContent }[];
  accountId: string;
  linuxProfile: string | null;
};

export type TurnOptions = {
  // Why: SSE fanout + durable event log share one callback; runTurn appends
  // each event (cursor attached) then calls this, so live and replay agree.
  onEvent?: (event: StreamEvent) => void;
  // Why: POST /messages now saves the user message synchronously (durable
  // first) so no refresh can observe a thread without it. When set, runTurn
  // speaks for that row instead of inserting a duplicate.
  alreadySavedUserMessage?: { id: string; text: string };
  // Why: the HTTP layer claims the run before 202 (fast single insert) so the
  // background turn joins it instead of racing a second claim. Routines claim
  // kind=routine the same way. Absent = runTurn claims its own turn run.
  existingRunId?: string;
  kind?: "turn" | "routine";
  // Why: a worker failure is not a person speaking. The cue is shown only to
  // the model, and speakerId forces the parent who spawned the worker.
  cue?: string;
  speakerId?: string;
  // Why: a second turn on a busy room waits for the running run to land
  // (preserves old lock-queue behavior). POST passes 0 for fail-fast queueing.
  acquireTimeoutMs?: number;
};

type GenerateResult =
  | string
  | {
      text: string;
      cacheReadTokens?: number | null;
      proposal?: { kind: "memory" | "skill" | "prompt"; body: string; messageIds: string[] };
    };

/**
 * Runs one room turn with send_message voice and a crash-safe run ledger.
 * Why: the old whole-turn transaction + FOR UPDATE lock held a Postgres tx
 * open for the entire turn — a 2h job meant a 2h open tx, and a restart left
 * nothing behind. Now: claim (or join) a run row, commit per step, heartbeat
 * while the model works, land done/failed. Room serialization moved from the
 * lock to the one-running-run-per-room index + wait-acquire.
 * Input: database, account id, conversation id, incoming text/blocks, optional
 * model stub, skills root, options (onEvent/alreadySaved/existingRun/kind/timeout).
 * Output: replies saved this turn, in speaker then emission order.
 */
export async function runTurn(
  db: Db,
  accountId: string,
  conversationId: string,
  body: string | { text: string; blocks?: { kind: string; [key: string]: unknown }[] | null; replyTo?: string | null },
  generate?: (input: TurnInput) => Promise<GenerateResult>,
  skillsRoot?: string,
  options?: TurnOptions,
) {
  // Validate without locking: serialization lives in the run ledger now.
  const [room] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  if (!room) {
    throw new Error("Room not found");
  }

  const memberRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(members)
    .innerJoin(agents, eq(members.agentId, agents.id))
    .where(and(eq(members.conversationId, conversationId), eq(members.accountId, accountId)));

  // Claim the turn slot (or join a run the HTTP layer already claimed).
  // Throws "room is busy" past the timeout — POST treats that as queued.
  const runId =
    options?.existingRunId ??
    (await acquireRun(db, accountId, conversationId, options?.kind ?? "turn", options?.acquireTimeoutMs)).id;
  await heartbeatRun(db, runId).catch(() => {
    // Heartbeat best-effort; the turn proceeds regardless.
  });

  // Persist-then-fanout: every event lands in the durable log first (cursor
  // attached for SSE resume), then goes live. Log failure degrades to live
  // only — the message row itself already committed separately.
  const emit = async (event: TurnEvent): Promise<void> => {
    try {
      const row = await appendEvent(db, { accountId, conversationId, runId, event });
      options?.onEvent?.({ ...event, cursor: row.id });
    } catch {
      options?.onEvent?.(event);
    }
  };

  let stamp = Date.now();
  const nextTime = () => new Date(stamp++);
  const incoming = typeof body === "string" ? { text: body, blocks: null as null, replyTo: null as null } : body;
  if (!options?.cue) {
    if (options?.alreadySavedUserMessage) {
      // Durable-first path: tag the pre-saved row with this run for traceability.
      await db
        .update(messages)
        .set({ runId })
        .where(and(eq(messages.id, options.alreadySavedUserMessage.id), eq(messages.accountId, accountId)));
    } else {
      await saveUserMessage(db, accountId, conversationId, {
        text: incoming.text,
        blocks: incoming.blocks,
        replyTo: incoming.replyTo,
        runId,
      });
    }
  }

  // Heartbeat while the model works so the scheduler never mistakes a live
  // 2h turn for a crash. Unref'd: tests and CLI exits never hang on it.
  const beat = setInterval(() => {
    void heartbeatRun(db, runId).catch(() => {});
  }, HEARTBEAT_MS);
  (beat as unknown as { unref?: () => void }).unref?.();

  const saved: (typeof messages.$inferSelect)[] = [];
  try {
    const spoken = new Set<string>();
    const queue = options?.speakerId ? [options.speakerId] : speakers(incoming.text, memberRows, room.ownerAgentId);
    while (queue.length > 0) {
      const agentId = queue.shift();
      if (!agentId || spoken.has(agentId)) {
        continue;
      }
      spoken.add(agentId);
      await speakOnce(db, {
        accountId,
        conversationId,
        agentId,
        memberRows,
        room,
        skillsRoot,
        generate,
        nextTime,
        runId,
        emit,
        saved,
        queue,
        spoken,
        cue: options?.cue,
      });
      await heartbeatRun(db, runId).catch(() => {});
    }
    await finishRun(db, runId);
    await emit({ type: "run", run: { id: runId, status: "done" as const, error: null } });
    options?.onEvent?.({ type: "done" });
    return saved;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The turn failed.";
    await failRun(db, runId, message).catch(() => {});
    await emit({ type: "error", error: message });
    throw error;
  } finally {
    clearInterval(beat);
    // The run row is already done or failed, so the room slot is free.
    // Start anything that queued during this turn before we return.
    await continueQueuedTurn(db, accountId, conversationId, generate, skillsRoot, options?.onEvent).catch(() => {});
  }
}

/**
 * Starts the next turn for text that arrived while this room was busy.
 * Why: the person should not wait for the scheduler tick. The ending turn
 * claims the queue and speaks for the newest row; earlier rows are already
 * in the thread. A busy claim puts the newest row back so the turn that
 * holds the room picks it up when it ends.
 * Input: db, account/conversation ids, optional model stub, skills root, live event callback.
 * Output: true when a follow-up turn started.
 */
export async function continueQueuedTurn(
  db: Db,
  accountId: string,
  conversationId: string,
  generate?: (input: TurnInput) => Promise<GenerateResult>,
  skillsRoot?: string,
  onEvent?: (event: StreamEvent) => void,
): Promise<boolean> {
  const claimed = await claimQueuedForRoom(db, accountId, conversationId);
  const latest = claimed[claimed.length - 1];
  if (!latest) return false;
  let runId: string;
  try {
    runId = (await acquireRun(db, accountId, conversationId, "turn", 0)).id;
  } catch (error) {
    await db
      .update(messages)
      .set({ queued: true })
      .where(and(eq(messages.id, latest.id), eq(messages.accountId, accountId)))
      .catch(() => {});
    if (error instanceof Error && /busy/.test(error.message)) return false;
    throw error;
  }
  await runTurn(db, accountId, conversationId, latest.body, generate, skillsRoot, {
    existingRunId: runId,
    alreadySavedUserMessage: { id: latest.id, text: latest.body },
    onEvent,
  });
  return true;
}

/**
 * Wakes the parent after a worker fails or returns nothing.
 * Why: the parent turn has already ended, so nobody is watching the
 * delegation. This hidden cue tells that same agent to rewrite the task
 * once, or to tell the person if the retry also failed. Not saved as a
 * user message.
 * Input: db, room/parent ids, the failed settlement. Output: nothing.
 */
async function resumeParentAfterWorker(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    parentAgentId: string;
    skillsRoot?: string;
    settled: { workerId: string; task: string; result: string };
  },
): Promise<void> {
  const failures = await failuresSinceLastUser(db, input.accountId, input.conversationId, input.parentAgentId);
  const cue = workerFollowupCue({
    workerId: input.settled.workerId,
    task: input.settled.task,
    result: input.settled.result,
    retry: failures <= 1,
  });
  await runTurn(db, input.accountId, input.conversationId, cue, undefined, input.skillsRoot, {
    cue,
    speakerId: input.parentAgentId,
    acquireTimeoutMs: 120_000,
    onEvent: (event) => publish(input.accountId, input.conversationId, event),
  });
}

/**
 * Posts one finished worker's result to the room in the parent's voice.
 * Why: the worker cannot message the person. Its final text is posted once.
 * A NEEDS_PERSON line means the screen is waiting on them: their computer is
 * handed over and they are pinged, instead of the agent typing a password.
 * Input: db, room/parent ids, delegation id, settled worker. Output: "delivered" or "skipped".
 */
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
  if (await alreadyDelivered(db, {
    accountId: input.accountId,
    conversationId: input.conversationId,
    parentAgentId: input.parentAgentId,
    result: input.settled.result,
  })) {
    return "skipped";
  }
  if (!(await claimDelivery(db, input.delegationId))) {
    return "skipped";
  }
  const raw = input.settled.result.trim().slice(0, 4000) || "The worker finished with no output.";
  const needs = raw.match(/NEEDS_PERSON:\s*(.+)/i);
  const text = needs
    ? `I need you on my computer. ${needs[1].trim()} Tell me when you're done and I'll continue.`
    : raw;
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

/**
 * Runs one speaker's step: load, think, emit, summarize, chain.
 * Why: extracted from runTurn so the loop stays readable — each step is
 * independent short transactions, never one giant tx. Emits (message events,
 * summaries, proposals) commit per bubble; a later failure keeps earlier work.
 * Input: db + speaker context (ids, rows, buffers, queue). Output: nothing;
 * appends to saved/emitted buffers and the mention queue in place.
 */
async function speakOnce(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    agentId: string;
    memberRows: { id: string; name: string }[];
    room: { title: string; kind: string };
    skillsRoot?: string;
    generate?: (input: TurnInput) => Promise<GenerateResult>;
    nextTime: () => Date;
    runId: string;
    emit: (event: TurnEvent) => Promise<void>;
    saved: (typeof messages.$inferSelect)[];
    queue: (string | undefined)[];
    spoken: Set<string>;
    cue?: string;
  },
): Promise<void> {
  const { accountId, conversationId, agentId, memberRows, room, skillsRoot, generate, nextTime, runId, emit, saved, queue, spoken, cue } = input;
  let [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
  if (!agent) {
    throw new Error("Agent not found");
  }
  // Lazy OS profile: model-hired subagents join the room without a Unix
  // user, and containers can vanish under long-lived accounts. Provision
  // here so the speaker always has computer tools when the daemon is up.
  // Degrades gracefully — chat still works, just without shell/desktop —
  // because a computer outage must not silence the conversation.
  if (!agent.linuxProfile) {
    try {
      const profile = await createProfile(db, accountId, agentId);
      const [refreshed] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
      if (refreshed) agent = refreshed;
      void profile;
    } catch {
      // Computer unavailable; continue with linuxProfile null.
    }
  }
  const history = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)))
    .orderBy(asc(messages.createdAt));
  const summary = await db
    .select()
    .from(summaryItems)
    .where(and(eq(summaryItems.conversationId, conversationId), eq(summaryItems.accountId, accountId)));
  const catalog = skillsRoot
    ? skillCatalogForAccount(skillsRoot, accountId)
        .map((skill) => `${skill.name}: ${skill.description}`)
        .join("\n")
    : "";
  const context = buildContext({
    accountId,
    agentId: agent.id,
    promptVersion: agent.promptVersion,
    identity: {
      name: agent.name,
      role: agent.role,
      personality: agent.personality,
      job: agent.jobDescription,
    },
    summary: summary.map((item) => ({ key: item.key, body: item.body })),
    messages: history.map((message) => ({ body: message.body })),
    tools: listTools([]).map((t) => t.name),
    catalog,
    room: {
      title: room.title,
      kind: room.kind,
      members: memberRows.map((member) => member.name),
      selfName: agent.name,
    },
  });
  // Per-speaker emission buffer: the real model path appends via tool
  // closures in replyWithModelTx; injected stubs return plain text.
  // History carries vision parts for recent user images (toModelMessages)
  // plus text fallback in the tail, so the agent sees attachments.
  const emittedMessages: (typeof messages.$inferSelect)[] = [];
  const modelMessages = toModelMessages(history);
  if (cue) modelMessages.push({ role: "user", content: cue });
  const useStub = typeof generate === "function";
  const generateWithStore = useStub
    ? () =>
        (generate as (input: TurnInput) => Promise<GenerateResult>)({
          agentId,
          provider: agent.provider,
          modelId: agent.modelId,
          system: context.prefix,
          prefix: context.prefix,
          tail: context.tail,
          promptCacheKey: context.openai.promptCacheKey,
          accountId,
          linuxProfile: agent.linuxProfile,
          messages: modelMessages,
        })
    : () =>
        replyWithModelTx(db, db, {
          agentId,
          provider: agent.provider,
          modelId: agent.modelId,
          system: context.prefix,
          prefix: context.prefix,
          tail: context.tail,
          promptCacheKey: context.openai.promptCacheKey,
          accountId,
          linuxProfile: agent.linuxProfile,
          conversationId,
          runId,
          skillsRoot,
          nextTime,
          emittedMessages,
          emit,
          messages: modelMessages,
        });
  let result: ReturnType<typeof unwrap>;
  try {
    result = unwrap(await generateWithStore());
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    // Trace the real exception: the bubble below is deliberately generic for
    // the phone, so without this line key/model/network failures are
    // indistinguishable. Truncated, never secrets (provider errors carry none).
    void traceError({
      accountId,
      conversationId,
      agentId,
      runId,
      kind: "generate-error",
      message: message.slice(0, 500),
    });
    result = {
      text: message.startsWith("Add an API key")
        ? message
        : "The model provider failed. Check the provider key, model id, and endpoint.",
      cacheReadTokens: null,
    };
  }
  if (emittedMessages.length > 0) {
    // Real tool path: send_message rows already inserted + emitted in order.
    for (const row of emittedMessages) {
      saved.push(row);
      await mergeSummary(db, accountId, conversationId, [{ key: "topics", body: row.body, messageId: row.id }]);
    }
    if (result.proposal) {
      await propose(db, accountId, {
        agentId,
        kind: result.proposal.kind,
        body: result.proposal.body,
        messageIds: result.proposal.messageIds,
      });
    }
    // Delegated bubbles (viaAgentId set) never chain-wake: the child speaks
    // via the parent by design, and its prose "@Name ..." is not a handoff.
    // Only the speaker's own voice can hand off with a leading @Name.
    const chainSource = emittedMessages
      .filter((m) => !m.viaAgentId)
      .map((m) => m.body)
      .join("\n");
    for (const next of mentioned(chainSource, memberRows, true)) {
      if (!spoken.has(next)) queue.push(next);
    }
    return;
  }
  // Stub/compat path: wrap raw text as one rich bubble.
  const text = result.text.trim();
  const bodyText = text || "The tools finished, but the model sent no message.";
  const [wrapped] = await db
    .insert(messages)
    .values({
      accountId,
      conversationId,
      agentId,
      runId,
      body: bodyText,
      kind: "rich",
      payload: [{ kind: "text", markdown: bodyText }],
      cacheReadTokens: result.cacheReadTokens,
      createdAt: nextTime(),
    })
    .returning();
  saved.push(wrapped!);
  await emit({ type: "message", message: wrapped! });
  if (text) {
    await mergeSummary(db, accountId, conversationId, [{ key: "topics", body: text, messageId: wrapped!.id }]);
  }
  if (result.proposal) {
    await propose(db, accountId, {
      agentId,
      kind: result.proposal.kind,
      body: result.proposal.body,
      messageIds: result.proposal.messageIds,
    });
  }
  for (const next of mentioned(result.text, memberRows, true)) {
    if (!spoken.has(next)) {
      queue.push(next);
    }
  }
}

/**
 * Lists the Linux tool names a worker can call.
 * Why: tests lock the worker set. The chatting agent does not receive these
 * tools, so a search cannot hold the room. The names live in profile-tools.ts.
 * Input: none. Output: sorted tool names.
 */
export function linuxToolNames(): string[] {
  return profileToolNames();
}

function mentioned(body: string, memberRows: { id: string; name: string }[], onlyLeading = false): string[] {
  // User messages wake every @mentioned agent (explicit address). Agent
  // replies chain-wake ONLY on a leading @Name — "@Smoke check the logs" is
  // a handoff, "thanks @Smoke" is prose. Without this, any incidental mention
  // in a reply summons uninvited speakers into the thread.
  if (!onlyLeading) {
    return speakers(body, memberRows, "").filter((id) => id !== "");
  }
  const leading = /^\s*@([A-Za-z0-9_-]+)/.exec(body)?.[1] ?? "";
  const member = memberRows.find((row) => row.name === leading);
  return member ? [member.id] : [];
}

/**
 * Extracts searchable text from a turn message, ignoring image parts.
 * Why: mention routing and test stubs reason about words, not pixels.
 * Input: string or content parts. Output: the joined text.
 */
export function textOf(content: TurnMessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n");
}

const MAX_VISION_IMAGES = 3;
const MAX_VISION_CHARS = 1_000_000;

/**
 * Builds model messages with vision parts for recent user images.
 * Why: the agent must SEE what the user sent (a screenshot of an SEO issue,
 * a photo of an error) instead of only reading "[image]". Only the newest 3
 * user images ride along — previews preferred, oversized originals skipped
 * (the agent opens those via savedPath) — so long threads stay cheap.
 * data: URIs become file parts with exact mimes (no deprecation warnings);
 * remote https URLs keep the legacy image shape (mime unknown).
 * Input: history rows with agentId/body/payload. Output: role+content rows.
 */
export function toModelMessages(
  history: { agentId: string | null; body: string; payload: unknown }[],
): { role: "user" | "assistant"; content: TurnMessageContent }[] {
  const wanted = new Map<number, TurnImagePart[]>();
  let remaining = MAX_VISION_IMAGES;
  for (let index = history.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const row = history[index]!;
    if (row.agentId || !Array.isArray(row.payload)) continue;
    for (const block of row.payload) {
      if (remaining === 0) break;
      if (typeof block !== "object" || block === null || (block as { kind?: string }).kind !== "image") continue;
      const image = block as { url?: string; previewUrl?: string };
      const ref = typeof image.previewUrl === "string" && image.previewUrl.length > 0 ? image.previewUrl : image.url;
      if (typeof ref !== "string" || ref.length === 0 || ref.length > MAX_VISION_CHARS) continue;
      const part = toImagePart(ref);
      if (!part) continue;
      const list = wanted.get(index) ?? [];
      list.unshift(part);
      wanted.set(index, list);
      remaining -= 1;
    }
  }
  return history.map((row, index) => {
    const role = row.agentId ? "assistant" : "user";
    const parts = wanted.get(index);
    if (!parts || parts.length === 0) return { role, content: row.body };
    return {
      role,
      content: [{ type: "text", text: row.body }, ...parts],
    } as { role: "user" | "assistant"; content: TurnMessageContent };
  });
}

/**
 * Converts one image reference to a model content part.
 * Why: single choke point for the image-vs-file-part decision, unit-tested
 * without a provider. data: URIs split into exact {data, mediaType} file
 * parts; remote URLs stay legacy image parts.
 * Input: data: URI or https URL. Output: the part, or null when unusable.
 */
export function toImagePart(ref: string): TurnImagePart | null {
  if (ref.startsWith("data:")) {
    const parsed = parseDataUri(ref);
    if (!parsed) return null;
    return { type: "file", data: parsed.base64, mediaType: parsed.mime };
  }
  try {
    const parsed = new URL(ref);
    if (parsed.protocol !== "https:") return null;
    return { type: "image", image: ref };
  } catch {
    return null;
  }
}

function unwrap(result: GenerateResult): {
  text: string;
  cacheReadTokens: number | null;
  proposal?: { kind: "memory" | "skill" | "prompt"; body: string; messageIds: string[] };
} {
  if (typeof result === "string") {
    return { text: result, cacheReadTokens: null };
  }
  return { text: result.text, cacheReadTokens: result.cacheReadTokens ?? null, proposal: result.proposal };
}

/**
 * Splits a turn into instructions and chat messages.
 * Input: the provider, the cached prefix, the tail, and the recent messages.
 * Output: system text in `instructions`, and only user or assistant rows in `messages`.
 */
export function toModelPrompt(input: Pick<TurnInput, "provider" | "prefix" | "tail" | "messages">): {
  instructions: SystemModelMessage[];
  messages: ModelMessage[];
} {
  const prefix: SystemModelMessage =
    input.provider === "anthropic"
      ? {
          role: "system",
          content: input.prefix,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        }
      : { role: "system", content: input.prefix };
  return {
    instructions: [prefix, { role: "system", content: input.tail }],
    // TurnMessageContent is the provider-accepted shape (plain text or
    // text+image parts); the cast bridges our narrow local type.
    messages: input.messages as ModelMessage[],
  };
}

/**
 * Runs a delegated child now, inside the parent's turn.
 * Why: a visible handoff has to actually speak — recording the intent is not
 * delivery. Bubbles save under the child with viaAgentId set to the parent,
 * so the room shows who asked. History is a short slice plus the task, not
 * the whole transcript. Mentions in the child's text do not wake anyone;
 * depth is capped by the caller before this runs.
 * Input: db, parent/child/run ids, task, emission buffers, optional generate stub.
 * Output: the child's bubbles, in send order. Throws if the child is gone.
 */
export async function runDelegatedTurn(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    runId: string;
    parentAgentId: string;
    childAgentId: string;
    delegationId: string;
    task: string;
    skillsRoot?: string;
    nextTime: () => Date;
    emittedMessages: (typeof messages.$inferSelect)[];
    emit: (event: TurnEvent) => Promise<void>;
    delegationDepth: number;
    generate?: (input: TurnInput) => Promise<GenerateResult>;
  },
): Promise<(typeof messages.$inferSelect)[]> {
  const [child] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, input.childAgentId), eq(agents.accountId, input.accountId)));
  if (!child) throw new Error("Delegate target is not on this account.");
  const recent = (
    await db
      .select({ agentId: messages.agentId, body: messages.body })
      .from(messages)
      .where(and(eq(messages.conversationId, input.conversationId), eq(messages.accountId, input.accountId)))
      .orderBy(desc(messages.createdAt))
      .limit(DELEGATION_HISTORY_SLICE)
  ).reverse();

  if (input.generate) {
    const identity = identityBlock(child);
    const result = unwrap(
      await input.generate({
        agentId: child.id,
        provider: child.provider,
        modelId: child.modelId,
        system: identity,
        prefix: identity,
        tail: input.task,
        promptCacheKey: `${input.accountId}:${child.id}`,
        accountId: input.accountId,
        linuxProfile: child.linuxProfile,
        messages: [{ role: "user", content: input.task }],
      }),
    );
    const text = result.text.trim() || "The delegated agent sent no message.";
    const [wrapped] = await db
      .insert(messages)
      .values({
        accountId: input.accountId,
        conversationId: input.conversationId,
        agentId: child.id,
        runId: input.runId,
        viaAgentId: input.parentAgentId,
        body: text,
        kind: "rich",
        payload: [{ kind: "text", markdown: text }],
        createdAt: input.nextTime(),
      })
      .returning();
    if (!wrapped) throw new Error("Delegated reply insert returned no row.");
    input.emittedMessages.push(wrapped);
    await input.emit({ type: "message", message: wrapped });
    return [wrapped];
  }

  let profile: string | null = child.linuxProfile;
  if (!profile) {
    try {
      profile = await createProfile(db, input.accountId, child.id);
    } catch {
      profile = null;
    }
  }
  const [room] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, input.accountId)));
  if (!room) throw new Error("Room not found");
  const memberRows = await db
    .select({ id: agents.id, name: agents.name })
    .from(members)
    .innerJoin(agents, eq(members.agentId, agents.id))
    .where(and(eq(members.conversationId, input.conversationId), eq(members.accountId, input.accountId)));
  const context = buildContext({
    accountId: input.accountId,
    agentId: child.id,
    promptVersion: child.promptVersion,
    identity: {
      name: child.name,
      role: child.role,
      personality: child.personality,
      job: child.jobDescription,
    },
    summary: [],
    messages: recent.map((row) => ({ body: row.body })),
    tools: listTools([]).map((item) => item.name),
    room: {
      title: room.title,
      kind: room.kind,
      members: memberRows.map((member) => member.name),
      selfName: child.name,
    },
  });
  const local: (typeof messages.$inferSelect)[] = [];
  await replyWithModelTx(db, db, {
    agentId: child.id,
    provider: child.provider,
    modelId: child.modelId,
    system: context.prefix,
    prefix: context.prefix,
    tail: `${context.tail}\n\nDelegated task (do this, do not fan out mentions): ${input.task}`,
    promptCacheKey: context.openai.promptCacheKey,
    accountId: input.accountId,
    linuxProfile: profile,
    conversationId: input.conversationId,
    runId: input.runId,
    skillsRoot: input.skillsRoot,
    nextTime: input.nextTime,
    emittedMessages: local,
    emit: input.emit,
    viaAgentId: input.parentAgentId,
    delegationDepth: input.delegationDepth,
    messages: [{ role: "user", content: input.task }],
  });
  for (const row of local) input.emittedMessages.push(row);
  return local;
}

/**
 * Builds the send_message tool bound to one speaker's run.
 * Why: shared by the full agentic loop so voice always speaks through the
 * identical durable path (short-tx insert + event log + immediate fanout).
 * Input: store plus speaker/run ids, timestamp fn, buffer, emit fn.
 * Output: the AI SDK send_message tool.
 */
function makeSendMessageTool(
  store: Store,
  input: {
    accountId: string;
    conversationId: string;
    agentId: string;
    runId: string;
    // Delegated speech renders under the child but attributed to the parent.
    viaAgentId?: string | null;
    nextTime: () => Date;
    emittedMessages: (typeof messages.$inferSelect)[];
    emit: (event: TurnEvent) => Promise<void>;
  },
) {
  return tool({
    description:
      "The only text the person sees. Call this first on every user turn: a direct answer, or a one-line ack that you started the work. Never include a process id. Call it again when check_worker has a result to deliver. Plain assistant text is invisible.",
    inputSchema: jsonSchema<{ blocks: unknown; replyTo?: string | null }>({
      type: "object",
      properties: { blocks: { type: "array" }, replyTo: { type: ["string", "null"] } },
      required: ["blocks"],
    }),
    execute: async ({ blocks, replyTo }) => {
      const parsed = sendMessageInputSchema.parse({ blocks, replyTo: replyTo ?? null });
      const saved = await saveSendMessage(store, {
        accountId: input.accountId,
        conversationId: input.conversationId,
        agentId: input.agentId,
        runId: input.runId,
        viaAgentId: input.viaAgentId ?? null,
        blocks: parsed.blocks,
        replyTo: parsed.replyTo,
        createdAt: input.nextTime(),
      });
      input.emittedMessages.push(saved);
      await input.emit({ type: "message", message: saved });
      return { messageId: saved.id };
    },
  });
}

/**
 * Calls the selected provider with the full voice + team + notify toolset.
 * Why: this is the only place model I/O happens, so all durable side effects
 * (send_message inserts, reactions, notifies, subagent hires, delegations)
 * funnel through short-tx tool executes in call order. Stateless stubs bypass
 * it in tests. Every emission also hits the event log + immediate fanout.
 * Input: db + store, agent/room/run ids, prompt parts, skills root, timestamp
 * fn, emission buffer, emit fn. Output: reply text (usually empty — voice went
 * via tools), cache tokens, optional proposal.
 */
async function replyWithModelTx(
  db: Db,
  store: Store,
  input: TurnInput & {
    conversationId: string;
    runId: string;
    skillsRoot?: string;
    nextTime: () => Date;
    emittedMessages: (typeof messages.$inferSelect)[];
    emit: (event: TurnEvent) => Promise<void>;
    viaAgentId?: string | null;
    delegationDepth?: number;
  },
): Promise<GenerateResult> {
  const credential = await keyFor(db, input.accountId, input.provider);
  const prompt = toModelPrompt(input);
  const profile = input.linuxProfile;
  const accountId = input.accountId;
  const conversationId = input.conversationId;
  const agentId = input.agentId;
  const runId = input.runId;
  const emit = input.emit;

  const voice = {
    send_message: makeSendMessageTool(store, {
      accountId,
      conversationId,
      agentId,
      runId,
      viaAgentId: input.viaAgentId ?? null,
      nextTime: input.nextTime,
      emittedMessages: input.emittedMessages,
      emit,
    }),
    react_to_message: tool({
      description: "One emoji tapback when a reaction is the whole reply and a message would be too much. Use instead of send_message only in that case. Rare, and mirror the person.",
      inputSchema: jsonSchema<{ messageId: string; emoji: string }>({
        type: "object",
        properties: { messageId: { type: "string" }, emoji: { type: "string" } },
        required: ["messageId", "emoji"],
      }),
      execute: async ({ messageId, emoji }) => {
        const parsed = reactionSchema.parse({ messageId, emoji });
        const saved = await saveReaction(store, { accountId, conversationId, agentId, messageId: parsed.messageId, emoji: parsed.emoji });
        await emit({ type: "reaction", reaction: saved });
        return { ok: true };
      },
    }),
    notify_user: tool({
      description:
        "Ping the person when you are blocked on them (approval, login, a decision) or something is urgent. Not for ordinary progress — that is send_message. An open room shows a banner; a closed app may push. One active ping per run: calling again updates it. Use action-needed only when you cannot continue without them.",
      inputSchema: jsonSchema<{ title: string; body: string; urgency?: string }>({
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" }, urgency: { type: "string" } },
        required: ["title", "body"],
      }),
      execute: async ({ title, body, urgency }) => {
        const parsed = notifyInputSchema.parse({ title, body, urgency: urgency ?? "info" });
        const note = await saveNotification(store, {
          accountId,
          conversationId,
          runId,
          agentId,
          title: parsed.title,
          body: parsed.body,
          urgency: parsed.urgency,
        });
        await emit({ type: "notify", notification: note });
        return { notificationId: note.id };
      },
    }),
    read_history: tool({
      description: "Read one cited message by id, or search a short slice (max 5). Use when a fact points at a specific message. Does not dump the transcript.",
      inputSchema: jsonSchema<{ messageId?: string; search?: string }>({
        type: "object",
        properties: { messageId: { type: "string" }, search: { type: "string" } },
      }),
      execute: async ({ messageId, search }) => {
        const rows = messageId
          ? await readHistory(store, accountId, conversationId, { messageId })
          : await readHistory(store, accountId, conversationId, { search: search ?? "" });
        return rows.map((r) => ({ id: r.id, body: r.body }));
      },
    }),
    read_skill: tool({
      description: "Load one skill's full instructions by name. Use only when this turn needs that procedure. Names in the prompt are the catalog, not the steps.",
      inputSchema: jsonSchema<{ name: string }>({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }),
      execute: async ({ name }) => {
        if (!input.skillsRoot) return "No skills directory configured.";
        try {
          return readSkillForAccount(input.skillsRoot, accountId, name);
        } catch {
          return "Skill not found.";
        }
      },
    }),
    hire_subagent: tool({
      description:
        "Create a lasting specialist on your team in this group (max 10, depth 2) and announce them with an agent card. Give role (job title), personality (tone), and job (standing duties) — e.g. social manager with its posting cadence. For one task while you stay in the chat, use spawn_worker. Refuses a private 1:1.",
      inputSchema: jsonSchema<{
        label: string;
        role: string;
        personality?: string;
        jobDescription: string;
        provider?: string;
        modelId?: string;
      }>({
        type: "object",
        properties: {
          label: { type: "string" },
          role: { type: "string" },
          personality: { type: "string" },
          jobDescription: { type: "string" },
          provider: { type: "string" },
          modelId: { type: "string" },
        },
        required: ["label", "role", "jobDescription"],
      }),
      execute: async ({ label, role, personality, jobDescription, provider, modelId }) => {
        const parsed = subagentCreateSchema.parse({
          label,
          role,
          personality,
          jobDescription,
          provider,
          modelId,
        });
        const child = await hireSubagent(store, {
          accountId,
          conversationId,
          parentAgentId: agentId,
          label: parsed.label,
          role: parsed.role,
          personality: parsed.personality,
          jobDescription: parsed.jobDescription,
          provider: parsed.provider,
          modelId: parsed.modelId,
        });
        const card = await saveSendMessage(store, {
          accountId,
          conversationId,
          agentId,
          runId,
          blocks: [{ kind: "widget", widget: "agent-card", props: { agentId: child.id, label: child.label, name: child.name } }],
          createdAt: input.nextTime(),
        });
        input.emittedMessages.push(card);
        await emit({ type: "message", message: card });
        return { agentId: child.id, name: child.name };
      },
    }),
    delegate: tool({
      description:
        "Hand a task to a teammate already in this room and wait until they answer. Their bubbles show as them, via you. Use only when that reply should appear in the room and you can wait. To stay available, use spawn_worker instead.",
      inputSchema: jsonSchema<{ agentId: string; task: string }>({
        type: "object",
        properties: { agentId: { type: "string" }, task: { type: "string" } },
        required: ["agentId", "task"],
      }),
      execute: async ({ agentId: childId, task }) => {
        const parsed = delegateSchema.parse({ agentId: childId, task });
        if ((input.delegationDepth ?? 0) >= MAX_DELEGATION_DEPTH) {
          throw new Error("Delegation is already two levels deep — do this part yourself.");
        }
        const row = await recordDelegation(store, { accountId, conversationId, parentAgentId: agentId, agentId: parsed.agentId, task: parsed.task });
        try {
          const bubbles = await runDelegatedTurn(db, {
            accountId,
            conversationId,
            runId,
            parentAgentId: agentId,
            childAgentId: parsed.agentId,
            delegationId: row.id,
            task: parsed.task,
            skillsRoot: input.skillsRoot,
            nextTime: input.nextTime,
            emittedMessages: input.emittedMessages,
            emit,
            delegationDepth: (input.delegationDepth ?? 0) + 1,
          });
          await db
            .update(delegations)
            .set({ status: "done", result: bubbles.map((bubble) => bubble.body).join("\n\n").slice(0, 20_000) })
            .where(eq(delegations.id, row.id));
          return { delegationId: row.id, bubbles: bubbles.length };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Delegation failed.";
          await db
            .update(delegations)
            .set({ status: "failed", result: message.slice(0, 20_000) })
            .where(eq(delegations.id, row.id))
            .catch(() => {});
          throw error;
        }
      },
    }),
    list_team: tool({
      description: "List your team agents (id, name, label, role). Use before delegate so you choose someone already on the team.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => listTeam(store, accountId, agentId),
    }),
    add_to_group: tool({
      description:
        "Add an existing account agent to this group room. Use when the team grows after creation. Never works on a private 1:1 — those stay 1:1, create a group instead.",
      inputSchema: jsonSchema<{ agentId: string }>({
        type: "object",
        properties: { agentId: { type: "string" } },
        required: ["agentId"],
      }),
      execute: async ({ agentId: inviteId }) => {
        const row = await addGroupMember(store, { accountId, conversationId, agentId: inviteId });
        return { agentId: row.agentId };
      },
    }),
    todo_write: tool({
      description:
        "Replace your worklist for this job with small items in pending, in_progress, or completed. Use on multi-step work so a later turn, a routine wake, or a new worker can resume it. Read it back with todo_list.",
      inputSchema: jsonSchema<{ todos: { content: string; status: string }[] }>({
        type: "object",
        properties: { todos: { type: "array" } },
        required: ["todos"],
      }),
      execute: async ({ todos }) =>
        todoWrite(
          store,
          accountId,
          agentId,
          // Validated + narrowed by todoWrite's Zod schema; the loose tool
          // schema keeps the model from over-constraining status strings.
          todos as { content: string; status: "pending" | "in_progress" | "completed" }[],
        ),
    }),
    todo_list: tool({
      description: "Read your current worklist. Use after a restart, a routine wake, or when continuing a job a worker started.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => todoList(store, accountId, agentId),
    }),
    create_group: tool({
      description:
        "Open a new group room you own, with the listed agents. Use when teamwork must be visible to the person. Private 1:1 chats cannot gain members. Tell the person about the group with send_message after.",
      inputSchema: jsonSchema<{ title: string; memberIds: string[] }>({
        type: "object",
        properties: { title: { type: "string" }, memberIds: { type: "array" } },
        required: ["title", "memberIds"],
      }),
      execute: async ({ title, memberIds }) => {
        const parsed = groupCreateInputSchema.parse({ title, memberIds });
        const room = await createGroupRoom(store, {
          accountId,
          ownerAgentId: agentId,
          title: parsed.title,
          memberIds: parsed.memberIds,
        });
        return { conversationId: room.id, title: room.title, members: room.members.length };
      },
    }),
    spawn_worker: tool({
      description:
        "The only way to search, fetch a page, read or write a file, run a command, or use the desktop, including opening Chrome. You do not have those tools. A login is not a refusal: the task opens the page and, if a password, 2FA, captcha, or payment appears, the worker stops with NEEDS_PERSON and one instruction. Never type their password. Returns immediately. Tell the person you started, with no process id, then stop. A lookup uses web_search then web_fetch. Chrome only when they asked to open or use the browser.",
      inputSchema: jsonSchema<{
        label: string;
        role: string;
        personality?: string;
        jobDescription: string;
        task: string;
        provider?: string;
        modelId?: string;
      }>({
        type: "object",
        properties: {
          label: { type: "string" },
          role: { type: "string" },
          personality: { type: "string" },
          jobDescription: { type: "string" },
          task: { type: "string" },
          provider: { type: "string" },
          modelId: { type: "string" },
        },
        required: ["label", "role", "jobDescription", "task"],
      }),
      execute: async ({ label, role, personality, jobDescription, task, provider, modelId }) => {
        const failed = await failuresSinceLastUser(store, accountId, conversationId, agentId);
        if (failed >= 2) {
          return {
            error:
              "Two workers already failed since the person's last message. Do not start another. send_message what failed, in plain words, then stop.",
          };
        }
        const parsed = spawnWorkerInputSchema.parse({
          label,
          role,
          personality,
          jobDescription,
          task,
          provider,
          modelId,
        });
        const spawned = await spawnWorker(store, {
          accountId,
          conversationId,
          parentAgentId: agentId,
          label: parsed.label,
          role: parsed.role,
          personality: parsed.personality,
          jobDescription: parsed.jobDescription,
          task: parsed.task,
          provider: parsed.provider,
          modelId: parsed.modelId,
        });
        void runWorker(db, {
          accountId,
          conversationId,
          parentAgentId: agentId,
          childId: spawned.workerId,
          delegationId: spawned.delegationId,
          task: parsed.task,
          skillsRoot: input.skillsRoot,
          onSettled: (settled) => {
            if (settled.status !== "failed") {
              // The worker's final text is the answer. Post it now, in the
              // parent's voice. A second model turn was dropping finished
              // results when the room was busy.
              void deliverWorkerResult(db, {
                accountId,
                conversationId,
                parentAgentId: agentId,
                delegationId: spawned.delegationId,
                skillsRoot: input.skillsRoot,
                settled,
              }).catch(() => {});
              return;
            }
            void resumeParentAfterWorker(db, {
              accountId,
              conversationId,
              parentAgentId: agentId,
              skillsRoot: input.skillsRoot,
              settled,
            }).catch(() => {});
          },
        });
        return spawned;
      },
    }),
    check_worker: tool({
      description:
        "Read a worker by the process id from spawn_worker. running: keep chatting. done: summarize the result in send_message, and do not invent anything it did not return. failed or empty: send one short line and spawn_worker once with a corrected task. If a retry already failed, tell the person and stop.",
      inputSchema: jsonSchema<{ workerId: string }>({
        type: "object",
        properties: { workerId: { type: "string" } },
        required: ["workerId"],
      }),
      execute: async ({ workerId }) => checkWorker(store, accountId, workerId),
    }),
    stop_worker: tool({
      description: "Stop a worker that is wedged, wrong, or no longer needed. Pass the process id from spawn_worker. Stopped work reads as failed with the reason.",
      inputSchema: jsonSchema<{ workerId: string }>({
        type: "object",
        properties: { workerId: { type: "string" } },
        required: ["workerId"],
      }),
      execute: async ({ workerId }) => stopWorker(store, accountId, workerId),
    }),
    create_routine: tool({
      description:
        "Schedule your own recurring job in this room, such as every day at 09:00 Europe/Berlin. Shapes: */N * * * * for an interval, M H * * * daily, M H * * D weekly, with an IANA timezone. It does not run the task now. Only creates a routine for yourself.",
      inputSchema: jsonSchema<{ body: string; cron: string; timezone?: string }>({
        type: "object",
        properties: { body: { type: "string" }, cron: { type: "string" }, timezone: { type: "string" } },
        required: ["body", "cron"],
      }),
      execute: async ({ body, cron, timezone }) => {
        const routine = await createOwnRoutine(store, {
          accountId,
          conversationId,
          agentId,
          body,
          cron,
          timezone: timezone ?? "UTC",
        });
        return { routineId: routine.id, nextRunAt: routine.nextRunAt };
      },
    }),
    update_routine: tool({
      description: "Change one of your own routines: instructions, schedule, timezone, or paused true/false. Use list_routines if you need the id. Pausing stops future runs. Cannot change anyone else's routine.",
      inputSchema: jsonSchema<{ routineId: string; body?: string; cron?: string; timezone?: string; paused?: boolean }>({
        type: "object",
        properties: {
          routineId: { type: "string" },
          body: { type: "string" },
          cron: { type: "string" },
          timezone: { type: "string" },
          paused: { type: "boolean" },
        },
        required: ["routineId"],
      }),
      execute: async ({ routineId, body, cron, timezone, paused }) => {
        const updated = await updateOwnRoutine(store, accountId, agentId, { routineId, body, cron, timezone, paused });
        if (!updated) throw new Error("No routine of yours with that id.");
        return { routineId: updated.id, nextRunAt: updated.nextRunAt, paused: updated.paused };
      },
    }),
    delete_routine: tool({
      description: "Delete one of your own routines and its pending runs. Use list_routines if you need the id. Cannot delete anyone else's routine.",
      inputSchema: jsonSchema<{ routineId: string }>({
        type: "object",
        properties: { routineId: { type: "string" } },
        required: ["routineId"],
      }),
      execute: async ({ routineId }) => {
        const parsed = routineIdSchema.parse({ routineId });
        const deleted = await deleteOwnRoutine(store, accountId, agentId, parsed.routineId);
        if (!deleted) throw new Error("No routine of yours with that id.");
        return { deleted: true };
      },
    }),
    list_routines: tool({
      description: "List your own routines with ids, schedules, pause state, and next run. Use before update_routine or delete_routine.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => listOwnRoutines(store, accountId, agentId),
    }),
  };

  // Prompt tracing (Phase 17 fix): one JSONL line per speaker with the exact
  // prefix + tail the model sees. Answers "why didn't it know X" definitively.
  void tracePrompt({
    accountId,
    conversationId,
    agentId,
    runId,
    kind: "prompt",
    prefix: input.prefix,
    tail: input.tail,
    promptCacheKey: input.promptCacheKey,
  });
  // Step tracing (Phase 17 fix): every model step appends one JSONL line with
  // each tool call + truncated input/output. Turns previously logged nothing
  // about tool use, so a silent model and a failing tool looked identical.
  // Best-effort: tracing never fails the turn. Counter closes over steps.
  let stepIndex = 0;
  const result = await generateText({
    model: getModel(input.provider, input.modelId, credential.apiKey, credential.baseUrl),
    instructions: prompt.instructions,
    messages: prompt.messages,
    // Computer tools stay on the worker. This turn only talks and spawns, so a
    // search cannot hold the room while the person sends the next message.
    tools: voice,
    stopWhen: isStepCount(12),
    providerOptions:
      input.provider === "openai"
        ? { openai: { promptCacheKey: input.promptCacheKey, promptCacheRetention: "24h" } }
        : undefined,
    onStepFinish: async (step) => {
      stepIndex += 1;
      const calls = (step.toolCalls ?? []).map((call) => {
        const name = (call as { toolName?: string }).toolName ?? "unknown";
        const matching = (step.toolResults ?? []).find(
          (r) => (r as { toolCallId?: string }).toolCallId === (call as { toolCallId?: string }).toolCallId,
        );
        const raw = matching ? (matching as { output?: unknown }).output ?? (matching as { result?: unknown }).result : null;
        const output =
          raw && typeof raw === "object" && "value" in (raw as Record<string, unknown>)
            ? (raw as { value: unknown }).value
            : raw;
        return {
          name,
          input: (call as { input?: unknown }).input ?? (call as { args?: unknown }).args ?? null,
          output: tracePreview(output ?? "(no result yet)"),
        };
      });
      await traceStep({
        accountId,
        conversationId,
        agentId,
        runId,
        step: stepIndex,
        text: (step.text ?? "").slice(0, 300),
        tools: calls,
      });
    },
  });

  return { text: result.text, cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens ?? null };
}

/**
 * Calls the selected provider once (legacy single-shot path for stubs/tests).
 * Why: kept as the default `generate` so existing callers and unit tests that
 * inject `(input) => "text"` keep working; production uses replyWithModelTx.
 * Input: the agent, the cached prefix, the tail, and the recent messages.
 * Output: the reply text and the cache read tokens the provider reported.
 */
export async function replyWithModel(db: Db, input: TurnInput): Promise<GenerateResult> {
  const credential = await keyFor(db, input.accountId, input.provider);
  const prompt = toModelPrompt(input);
  const result = await generateText({
    model: getModel(input.provider, input.modelId, credential.apiKey, credential.baseUrl),
    instructions: prompt.instructions,
    messages: prompt.messages,
    providerOptions:
      input.provider === "openai"
        ? { openai: { promptCacheKey: input.promptCacheKey, promptCacheRetention: "24h" } }
        : undefined,
  });

  return { text: result.text, cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens ?? null };
}

// Re-export for tests that import the event type from the turn module.
export type { TurnEvent };
export { blocksToText };
