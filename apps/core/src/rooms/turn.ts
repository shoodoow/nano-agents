import { generateText, isStepCount, jsonSchema, tool, type ModelMessage, type SystemModelMessage } from "ai";
import { sendMessageInputSchema, reactionSchema, subagentCreateSchema, delegateSchema } from "@nano-agents/shared";
import { and, asc, eq } from "drizzle-orm";
import { buildContext } from "../memory/context.js";
import { readHistory } from "../memory/memory.js";
import type { getDb } from "../db/client.js";
import { agents, conversations, members, messages, summaryItems } from "../db/schema.js";
import { keyFor } from "../keys/keys.js";
import { getModel } from "../model/get-model.js";
import { speakers } from "./mentions.js";
import { saveUserMessage } from "./rooms.js";
import { propose } from "../skills/proposals.js";
import { skillCatalog, readSkill } from "../skills/skills.js";
import { mergeSummary } from "../memory/summary.js";
import { listTools } from "../skills/tools.js";
import { bash, readFile, writeFile, screenshotImage, moveMouse, clickAt, typeText, pressKeys } from "../computer/computer.js";
import { accountHome, accountShared, createProfile } from "../linux/linux.js";
import { saveSendMessage, saveReaction, blocksToText, type TurnEvent } from "./send-message.js";
import { hireSubagent, recordDelegation, listTeam } from "./subagents.js";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type TurnMessageContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; image: string }>;

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
  // Why: SSE needs post-commit events; buffering in-tx then flushing keeps
  // ordering durable (rollback drops unsent bubbles) and stays single-process
  // safe. A future Redis fanout can subscribe to this same callback.
  onEvent?: (event: TurnEvent) => void;
  // Why: POST /messages now saves the user message synchronously (durable
  // first) so no refresh can observe a thread without it. When set, runTurn
  // speaks for that row instead of inserting a duplicate.
  alreadySavedUserMessage?: { id: string; text: string };
};

type GenerateResult =
  | string
  | {
      text: string;
      cacheReadTokens?: number | null;
      proposal?: { kind: "memory" | "skill" | "prompt"; body: string; messageIds: string[] };
    };

/**
 * Runs one room turn with send_message voice.
 * Why: the system prompt promises multi-message send_message + lone react
 * tapbacks; a single raw-text return cannot stream, carry images/widgets, or
 * show progress. Each speaker's tool calls insert immediately in-tx so later
 * steps see earlier bubbles; events flush post-commit for SSE.
 * Input: database, account id, conversation id, incoming text, optional model
 * stub, skills root, options with onEvent.
 * Output: replies saved this turn (one+ per speaker when multi-bubble), in
 * speaker then emission order. Conversation row stays locked until done.
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
  const pendingEvents: TurnEvent[] = [];
  const replies = await db.transaction(async (tx) => {
    const [room] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
      .for("update");
    if (!room) {
      throw new Error("Room not found");
    }

    const memberRows = await tx
      .select({ id: agents.id, name: agents.name })
      .from(members)
      .innerJoin(agents, eq(members.agentId, agents.id))
      .where(and(eq(members.conversationId, conversationId), eq(members.accountId, accountId)));

    let stamp = Date.now();
    const nextTime = () => new Date(stamp++);
    const incoming = typeof body === "string" ? { text: body, blocks: null as null, replyTo: null as null } : body;
    if (options?.alreadySavedUserMessage) {
      // Durable-first path: the HTTP layer already stored this message, so any
      // client refresh — even mid-turn — finds it. Never insert twice.
    } else {
      await saveUserMessage(tx as never, accountId, conversationId, {
        text: incoming.text,
        blocks: incoming.blocks,
        replyTo: incoming.replyTo,
      });
    }

    const spoken = new Set<string>();
    const queue = speakers(incoming.text, memberRows, room.ownerAgentId);
    const saved: (typeof messages.$inferSelect)[] = [];
    while (queue.length > 0) {
      const agentId = queue.shift();
      if (!agentId || spoken.has(agentId)) {
        continue;
      }
      spoken.add(agentId);
      let [agent] = await tx.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
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
          const profile = await createProfile(tx as never, accountId, agentId);
          const [refreshed] = await tx
            .select()
            .from(agents)
            .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
          if (refreshed) agent = refreshed;
          void profile;
        } catch {
          // Computer unavailable; continue with linuxProfile null.
        }
      }
      const history = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)))
        .orderBy(asc(messages.createdAt));
      const summary = await tx
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
      });
      // Per-speaker emission buffer: the real model path appends via tool
      // closures in replyWithModelTx; injected stubs return plain text.
      // History carries vision parts for recent user images (toModelMessages)
      // plus text fallback in the tail, so the agent sees attachments.
      const emittedMessages: (typeof messages.$inferSelect)[] = [];
      const modelMessages = toModelMessages(history);
      const useStub = typeof generate === "function";
      const generateWithTx = useStub
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
            replyWithModelTx(db, tx, {
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
              skillsRoot,
              nextTime,
              emittedMessages,
              pendingEvents,
              messages: modelMessages,
            });
      let result: ReturnType<typeof unwrap>;
      try {
        result = unwrap(await generateWithTx());
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
        // Real tool path: send_message rows already inserted in order.
        for (const row of emittedMessages) {
          saved.push(row);
          pendingEvents.push({ type: "message", message: row });
          await mergeSummary(tx, accountId, conversationId, [{ key: "topics", body: row.body, messageId: row.id }]);
        }
        if (result.proposal) {
          await propose(tx, accountId, {
            agentId,
            kind: result.proposal.kind,
            body: result.proposal.body,
            messageIds: result.proposal.messageIds,
          });
        }
        const chainSource = emittedMessages.map((m) => m.body).join("\n");
        for (const next of mentioned(chainSource, memberRows)) {
          if (!spoken.has(next)) queue.push(next);
        }
        continue;
      }
      // Stub/compat path: wrap raw text as one rich bubble.
      const text = result.text.trim();
      const bodyText = text || "The tools finished, but the model sent no message.";
      const [wrapped] = await tx
        .insert(messages)
        .values({
          accountId,
          conversationId,
          agentId,
          body: bodyText,
          kind: "rich",
          payload: [{ kind: "text", markdown: bodyText }],
          cacheReadTokens: result.cacheReadTokens,
          createdAt: nextTime(),
        })
        .returning();
      saved.push(wrapped!);
      pendingEvents.push({ type: "message", message: wrapped! });
      if (text) {
        await mergeSummary(tx, accountId, conversationId, [{ key: "topics", body: text, messageId: wrapped!.id }]);
      }
      if (result.proposal) {
        await propose(tx, accountId, {
          agentId,
          kind: result.proposal.kind,
          body: result.proposal.body,
          messageIds: result.proposal.messageIds,
        });
      }
      for (const next of mentioned(result.text, memberRows)) {
        if (!spoken.has(next)) {
          queue.push(next);
        }
      }
    }
    return saved;
  });
  for (const event of pendingEvents) options?.onEvent?.(event);
  options?.onEvent?.({ type: "done" });
  return replies;
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
    "read",
    "write",
  ].sort();
}

/**
 * Builds the Linux + grounded desktop toolset for one agent profile.
 * Why: single constructor for both model paths (agentic Tx path and legacy
 * single-shot) so the catalog, the prefix, and the callable tools can never
 * drift apart. Computer tools operate on the agent's assigned deterministic
 * display — the same :N the viewer proxies — and serialize per screen.
 * Input: account id + Linux username. Output: AI SDK tool map.
 */
function linuxTools(accountId: string, profile: string) {
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
  };
}

function mentioned(body: string, memberRows: { id: string; name: string }[]): string[] {
  return speakers(body, memberRows, "").filter((id) => id !== "");
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
 * Input: history rows with agentId/body/payload. Output: role+content rows.
 */
export function toModelMessages(
  history: { agentId: string | null; body: string; payload: unknown }[],
): { role: "user" | "assistant"; content: TurnMessageContent }[] {
  const wanted = new Map<number, string[]>();
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
      const list = wanted.get(index) ?? [];
      list.unshift(ref);
      wanted.set(index, list);
      remaining -= 1;
    }
  }
  return history.map((row, index) => {
    const role = row.agentId ? "assistant" : "user";
    const refs = wanted.get(index);
    if (!refs || refs.length === 0) return { role, content: row.body };
    return {
      role,
      content: [{ type: "text", text: row.body }, ...refs.map((image) => ({ type: "image", image }))],
    } as { role: "user" | "assistant"; content: TurnMessageContent };
  });
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
 * Calls the selected provider with the full voice + team toolset.
 * Why: this is the only place model I/O happens, so all durable side effects
 * (send_message inserts, reactions, subagent hires, delegations) funnel through
 * tx-backed tool executes in call order. Stateless stubs bypass it in tests.
 * Input: db + tx, agent/room ids, prompt parts, skills root, timestamp fn,
 * emission buffers. Output: reply text (usually empty — voice went via tools),
 * cache tokens, optional proposal.
 */
async function replyWithModelTx(
  db: Db,
  tx: Tx,
  input: TurnInput & {
    conversationId: string;
    skillsRoot?: string;
    nextTime: () => Date;
    emittedMessages: (typeof messages.$inferSelect)[];
    pendingEvents: TurnEvent[];
  },
): Promise<GenerateResult> {
  const credential = await keyFor(db, input.accountId, input.provider);
  const prompt = toModelPrompt(input);
  const profile = input.linuxProfile;
  const accountId = input.accountId;
  const conversationId = input.conversationId;
  const agentId = input.agentId;

  const voice = {
    send_message: tool({
      description:
        "Your only voice. Send one rich message now (text/image/widget/file/code blocks, optional replyTo). Call multiple times for multi-bubble replies. Plain assistant text is invisible.",
      inputSchema: jsonSchema<{ blocks: unknown; replyTo?: string | null }>({
        type: "object",
        properties: { blocks: { type: "array" }, replyTo: { type: ["string", "null"] } },
        required: ["blocks"],
      }),
      execute: async ({ blocks, replyTo }) => {
        const parsed = sendMessageInputSchema.parse({ blocks, replyTo: replyTo ?? null });
        const saved = await saveSendMessage(tx, {
          accountId,
          conversationId,
          agentId,
          blocks: parsed.blocks,
          replyTo: parsed.replyTo,
          createdAt: input.nextTime(),
        });
        input.emittedMessages.push(saved);
        return { messageId: saved.id };
      },
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
        const saved = await saveReaction(tx, { accountId, conversationId, agentId, messageId: parsed.messageId, emoji: parsed.emoji });
        input.pendingEvents.push({ type: "reaction", reaction: saved });
        return { ok: true };
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
          ? await readHistory(tx as never, accountId, conversationId, { messageId })
          : await readHistory(tx as never, accountId, conversationId, { search: search ?? "" });
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
        const child = await hireSubagent(tx, {
          accountId,
          conversationId,
          parentAgentId: agentId,
          label: parsed.label,
          description: parsed.description,
          provider: parsed.provider,
          modelId: parsed.modelId,
        });
        const card = await saveSendMessage(tx, {
          accountId,
          conversationId,
          agentId,
          blocks: [{ kind: "widget", widget: "agent-card", props: { agentId: child.id, label: child.label, name: child.name } }],
          createdAt: input.nextTime(),
        });
        input.emittedMessages.push(card);
        return { agentId: child.id, name: child.name };
      },
    }),
    delegate: tool({
      description: "Ask a team agent in this room to do a scoped task. Their reply streams as via you.",
      inputSchema: jsonSchema<{ agentId: string; task: string }>({
        type: "object",
        properties: { agentId: { type: "string" }, task: { type: "string" } },
        required: ["agentId", "task"],
      }),
      execute: async ({ agentId: childId, task }) => {
        const parsed = delegateSchema.parse({ agentId: childId, task });
        const row = await recordDelegation(tx, { accountId, conversationId, parentAgentId: agentId, agentId: parsed.agentId, task: parsed.task });
        return { delegationId: row.id };
      },
    }),
    list_team: tool({
      description: "List your team agents to pick a delegate.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => listTeam(tx, accountId, agentId),
    }),
  };

  const result = await generateText({
    model: getModel(input.provider, input.modelId, credential.apiKey, credential.baseUrl),
    instructions: prompt.instructions,
    messages: prompt.messages,
    tools: { ...voice, ...(profile ? linuxTools(accountId, profile) : {}) },
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
    tools: profile ? linuxTools(input.accountId, profile) : undefined,
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
