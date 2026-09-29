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
import { buildContext } from "../memory/context.js";
import { readHistory } from "../memory/memory.js";
import type { getDb, Store } from "../db/client.js";
import { agents, conversations, delegations, members, messages, summaryItems } from "../db/schema.js";
import { keyFor } from "../keys/keys.js";
import { getModel } from "../model/get-model.js";
import { speakers } from "./mentions.js";
import { createGroupRoom, saveUserMessage } from "./rooms.js";
import { propose } from "../skills/proposals.js";
import { skillCatalog, readSkill } from "../skills/skills.js";
import { mergeSummary } from "../memory/summary.js";
import { listTools } from "../skills/tools.js";
import { bash, readFile, writeFile, screenshotImage, moveMouse, clickAt, typeText, pressKeys } from "../computer/computer.js";
import { globFiles, grepFiles } from "../computer/find.js";
import { webFetch } from "../computer/web.js";
import { webSearch } from "../computer/search.js";
import { toolKeyFor } from "../keys/tools.js";
import { accountHome, accountShared, createProfile } from "../linux/linux.js";
import { saveNotification } from "../notify/notify.js";
import { todoList, todoWrite } from "../memory/todos.js";
import { createOwnRoutine, deleteOwnRoutine, listOwnRoutines, updateOwnRoutine } from "../routines/routines.js";
import { saveSendMessage, saveReaction, blocksToText, type TurnEvent } from "./send-message.js";
import { appendEvent } from "./events.js";
import { acquireRun, failRun, finishRun, heartbeatRun } from "./runs.js";
import type { StreamEvent } from "./stream.js";
import { parseDataUri } from "./uploads.js";
import { checkWorker, hireSubagent, listTeam, recordDelegation, runWorker, spawnWorker, stopWorker } from "./subagents.js";

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

  // Heartbeat while the model works so the scheduler never mistakes a live
  // 2h turn for a crash. Unref'd: tests and CLI exits never hang on it.
  const beat = setInterval(() => {
    void heartbeatRun(db, runId).catch(() => {});
  }, HEARTBEAT_MS);
  (beat as unknown as { unref?: () => void }).unref?.();

  const saved: (typeof messages.$inferSelect)[] = [];
  try {
    const spoken = new Set<string>();
    const queue = speakers(incoming.text, memberRows, room.ownerAgentId);
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
  }
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
  },
): Promise<void> {
  const { accountId, conversationId, agentId, memberRows, room, skillsRoot, generate, nextTime, runId, emit, saved, queue, spoken } = input;
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
    ? skillCatalog(skillsRoot)
        .map((skill) => `${skill.name}: ${skill.description}`)
        .join("\n")
    : "";
  const context = buildContext({
    accountId,
    agentId: agent.id,
    promptVersion: agent.promptVersion,
    description: agent.description,
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
    const chainSource = emittedMessages.map((m) => m.body).join("\n");
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
 * Lists the Linux + desktop tool names offered to the model.
 * Why: exported pure helper so tests lock the catalog without pulling AI SDK
 * tool generics into the public type surface (which breaks declaration emit).
 * Must stay in sync with linuxTools() below — same names, sorted.
 * Input: none. Output: sorted tool names.
 */
export function linuxToolNames(): string[] {
  return [
    "bash",
    "computer_click",
    "computer_key",
    "computer_mouse",
    "computer_screenshot",
    "computer_type",
    "glob",
    "grep",
    "read",
    "web_fetch",
    "web_search",
    "write",
  ].sort();
}

/**
 * Builds the Linux + grounded desktop toolset for one agent profile.
 * Why: single constructor for both model paths (agentic Tx path and legacy
 * single-shot) so the catalog, the prefix, and the callable tools can never
 * drift apart. Computer tools operate on the agent's assigned deterministic
 * display — the same :N the viewer proxies — and serialize per screen.
 * Search/files tools ride along because they exec inside the same container.
 * Input: database (for search keys), account id, Linux username.
 * Output: AI SDK tool map.
 */
function linuxTools(db: Db, accountId: string, profile: string) {
  const home = accountHome(accountId, profile);
  const shared = accountShared(accountId);
  return {
    read: tool({
      description: `Read a file in ${home} or ${shared}.`,
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      }),
      execute: async ({ path }) => readFile(accountId, profile, path),
    }),
    write: tool({
      description: `Write a file in ${home} or ${shared}.`,
      inputSchema: jsonSchema<{ path: string; body: string }>({
        type: "object",
        properties: { path: { type: "string" }, body: { type: "string" } },
        required: ["path"],
      }),
      execute: async ({ path, body }) => {
        await writeFile(accountId, profile, path, body);
        return "Wrote the file.";
      },
    }),
    bash: tool({
      description: "Run a shell command on your Linux computer. DISPLAY is already set to your assigned desktop (1280x800), so chromium and xterm open on the screen the person watches. Never start Xvfb/x11vnc or override DISPLAY.",
      inputSchema: jsonSchema<{ command: string }>({
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      }),
      execute: async ({ command }) => bash(accountId, profile, command),
    }),
    computer_screenshot: tool({
      description: "Take a PNG screenshot of YOUR assigned desktop (1280x800) for grounding. Always call before clicking. Returns display, size, and pngBase64.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => screenshotImage(accountId, profile),
    }),
    computer_mouse: tool({
      description: "Move the pointer to x/y (0-1279, 0-799) on your desktop. Ground from the latest screenshot first.",
      inputSchema: jsonSchema<{ x: number; y: number }>({
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      }),
      execute: async ({ x, y }) => moveMouse(accountId, profile, x, y),
    }),
    computer_click: tool({
      description: "Atomically move and left-click at x/y on your desktop. Prefer over mouse+separate click so grounding cannot race.",
      inputSchema: jsonSchema<{ x: number; y: number }>({
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      }),
      execute: async ({ x, y }) => clickAt(accountId, profile, x, y),
    }),
    computer_type: tool({
      description: "Type 1-4000 chars on your desktop. Focus the field with a click first.",
      inputSchema: jsonSchema<{ text: string }>({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      }),
      execute: async ({ text }) => typeText(accountId, profile, text),
    }),
    computer_key: tool({
      description: "Press one key combo: Return, Escape, Tab, arrows, F-keys, or ctrl/alt/shift+x.",
      inputSchema: jsonSchema<{ key: string }>({
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      }),
      execute: async ({ key }) => pressKeys(accountId, profile, key),
    }),
    web_fetch: tool({
      description:
        "Read one public web page as text (docs, skill directories, articles). JS-heavy pages render automatically. Returns title, text, and outlinks to follow. Never send the user to their own browser for something you can read yourself.",
      inputSchema: jsonSchema<{ url: string }>({
        type: "object",
        properties: { url: { type: "string", description: "Full https:// address." } },
        required: ["url"],
      }),
      execute: async ({ url }) => {
        const page = await webFetch(accountId, profile, url);
        const byline = [page.siteName, page.byline].filter((part) => part.length > 0).join(" · ");
        return [
          `# ${page.title || "(no title)"}${byline ? `\n${byline}` : ""}`,
          `Source: ${page.url}${page.rendered ? " (JS-rendered)" : ""}${page.truncated ? " [truncated]" : ""}`,
          "",
          page.markdown,
        ].join("\n");
      },
    }),
    web_search: tool({
      description:
        "Search the web first, then web_fetch the promising hits. Keyed providers (Brave, Exa) when configured, keyless DuckDuckGo otherwise. Returns title/url/snippet triples, not page text.",
      inputSchema: jsonSchema<{ query: string; numResults?: number }>({
        type: "object",
        properties: { query: { type: "string" }, numResults: { type: "number" } },
        required: ["query"],
      }),
      execute: async ({ query, numResults }) => {
        const [braveKey, exaKey] = await Promise.all([
          toolKeyFor(db, accountId, "brave").catch(() => null),
          toolKeyFor(db, accountId, "exa").catch(() => null),
        ]);
        const searched = await webSearch(accountId, profile, query, { numResults, braveKey, exaKey });
        if (searched.results.length === 0) return `No results (${searched.provider}). Try different words.`;
        return [
          `Search via ${searched.provider}:`,
          ...searched.results.map((row, index) => `${index + 1}. ${row.title}\n   ${row.url}\n   ${row.snippet}`),
        ].join("\n");
      },
    }),
    glob: tool({
      description: "List files matching a glob (e.g. **/*.ts) under your home or /shared. Capped at 100 paths.",
      inputSchema: jsonSchema<{ pattern: string; path?: string }>({
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      }),
      execute: async ({ pattern, path }) => globFiles(accountId, profile, pattern, path),
    }),
    grep: tool({
      description: "Search file contents for a regex under your home or /shared. Returns file:line hits, capped at 100.",
      inputSchema: jsonSchema<{ pattern: string; path?: string; include?: string }>({
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } },
        required: ["pattern"],
      }),
      execute: async ({ pattern, path, include }) => grepFiles(accountId, profile, pattern, { path, include }),
    }),
  };
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
    const result = unwrap(
      await input.generate({
        agentId: child.id,
        provider: child.provider,
        modelId: child.modelId,
        system: child.description,
        prefix: child.description,
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
    description: child.description,
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
      "FIRST ACTION ON EVERY USER TURN: call send_message before any other tool — a one-line acknowledgement naming your concrete first step. Then do the work with other tools, posting progress, and close with a final send_message. Plain assistant text is invisible: nothing reaches the user until it is inside send_message.",
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
      description: "Single emoji tapback when a reaction is the whole response. Rare; mirrors the user.",
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
        "Ping the person NOW mid-turn — approval needed, blocked on them (CAPTCHA, login, decision), or an urgent find. Room open gives an in-app banner; closed gives a push per their notify setting. One active ping per run: repeat calls update it instead of stacking. Use action-needed when the run cannot proceed without them.",
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
      description: "Read one cited message by id, or search a slice (max 5). Never dumps the transcript.",
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
      description: "Load one skill body by name. Catalog names alone are in the prefix.",
      inputSchema: jsonSchema<{ name: string }>({ type: "object", properties: { name: { type: "string" } }, required: ["name"] }),
      execute: async ({ name }) => {
        if (!input.skillsRoot) return "No skills directory configured.";
        try {
          return readSkill(input.skillsRoot, name);
        } catch {
          return "Skill not found.";
        }
      },
    }),
    hire_subagent: tool({
      description: "Create a child specialist on your team in this room (max 10, depth 2). Announces via agent-card.",
      inputSchema: jsonSchema<{ label: string; description: string; provider?: string; modelId?: string }>({
        type: "object",
        properties: {
          label: { type: "string" },
          description: { type: "string" },
          provider: { type: "string" },
          modelId: { type: "string" },
        },
        required: ["label", "description"],
      }),
      execute: async ({ label, description, provider, modelId }) => {
        const parsed = subagentCreateSchema.parse({ label, description, provider, modelId });
        const child = await hireSubagent(store, {
          accountId,
          conversationId,
          parentAgentId: agentId,
          label: parsed.label,
          description: parsed.description,
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
        "Hand a scoped task to a team agent IN THIS ROOM and wait for their answer. They run now — their bubbles stream attributed via you — and you get back what they did. Use for visible handoffs, not background work (that is spawn_worker).",
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
      description: "List your team agents to pick a delegate.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => listTeam(store, accountId, agentId),
    }),
    todo_write: tool({
      description:
        "Replace your worklist for this job (opencode-style): break multi-step work into small todos with pending/in_progress/completed states, and keep them current as you go. Survives restarts and compaction — read it back with todo_list after any interruption.",
      inputSchema: jsonSchema<{ todos: { content: string; status: string }[] }>({
        type: "object",
        properties: { todos: { type: "array" } },
        required: ["todos"],
      }),
      execute: async ({ todos }) => todoWrite(store, accountId, agentId, todos),
    }),
    todo_list: tool({
      description: "Read your current worklist. Use after interruptions, routine wakes, or worker revival to re-orient.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => todoList(store, accountId, agentId),
    }),
    create_group: tool({
      description:
        "Start a NEW group room with you as owner plus the listed agents — the only way to build a team thread. Private 1:1 chats can never gain members, so this is where teamwork happens. Announce the group with send_message after.",
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
        "Start private background help and keep chatting: a hidden worker (never a room member, never visible) does the long task while you stay responsive. Returns a process id — hand it to the user, then check_worker for the result and summarize it. Use for anything slow instead of blocking the chat.",
      inputSchema: jsonSchema<{ label: string; description: string; task: string }>({
        type: "object",
        properties: { label: { type: "string" }, description: { type: "string" }, task: { type: "string" } },
        required: ["label", "description", "task"],
      }),
      execute: async ({ label, description, task }) => {
        const parsed = spawnWorkerInputSchema.parse({ label, description, task });
        const spawned = await spawnWorker(store, {
          accountId,
          conversationId,
          parentAgentId: agentId,
          label: parsed.label,
          description: parsed.description,
          task: parsed.task,
        });
        void runWorker(db, {
          accountId,
          conversationId,
          parentAgentId: agentId,
          childId: spawned.workerId,
          delegationId: spawned.delegationId,
          task: parsed.task,
          skillsRoot: input.skillsRoot,
        });
        return spawned;
      },
    }),
    check_worker: tool({
      description: "Check a background worker by its process id: running (keep chatting), done (summarize its result), or failed (explain and take over or retry).",
      inputSchema: jsonSchema<{ workerId: string }>({
        type: "object",
        properties: { workerId: { type: "string" } },
        required: ["workerId"],
      }),
      execute: async ({ workerId }) => checkWorker(store, accountId, workerId),
    }),
    stop_worker: tool({
      description: "Abort a background worker that is wedged or obsolete. Stopped work reads as failed with the reason.",
      inputSchema: jsonSchema<{ workerId: string }>({
        type: "object",
        properties: { workerId: { type: "string" } },
        required: ["workerId"],
      }),
      execute: async ({ workerId }) => stopWorker(store, accountId, workerId),
    }),
    create_routine: tool({
      description:
        "Schedule your OWN recurring job ('remind me every day at 09:00 Europe/Berlin'). Cron shapes: '*/N * * * *', 'M H * * *' daily, 'M H * * D' weekly. Runs in this room through the normal turn path. Only ever creates for yourself.",
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
      description: "Change your own routine: new instructions, schedule, timezone, or paused true/false. Only your routines.",
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
      description: "Delete your own routine and its pending jobs. Only your routines.",
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
      description: "List your own routines with ids, schedules, pause state, and next run.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => listOwnRoutines(store, accountId, agentId),
    }),
  };

  const result = await generateText({
    model: getModel(input.provider, input.modelId, credential.apiKey, credential.baseUrl),
    instructions: prompt.instructions,
    messages: prompt.messages,
    tools: { ...voice, ...(profile ? linuxTools(db, accountId, profile) : {}) },
    stopWhen: isStepCount(12),
    providerOptions:
      input.provider === "openai"
        ? { openai: { promptCacheKey: input.promptCacheKey, promptCacheRetention: "24h" } }
        : undefined,
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
  const profile = input.linuxProfile;
  const result = await generateText({
    model: getModel(input.provider, input.modelId, credential.apiKey, credential.baseUrl),
    instructions: prompt.instructions,
    messages: prompt.messages,
    tools: profile ? linuxTools(db, input.accountId, profile) : undefined,
    stopWhen: profile ? isStepCount(12) : undefined,
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
