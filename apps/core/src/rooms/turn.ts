import { generateText, isStepCount, jsonSchema, tool, type ModelMessage, type SystemModelMessage } from "ai";
import { and, asc, eq } from "drizzle-orm";
import { buildContext } from "../memory/context.js";
import type { getDb } from "../db/client.js";
import { agents, conversations, members, messages, summaryItems } from "../db/schema.js";
import { keyFor } from "../keys/keys.js";
import { getModel } from "../model/get-model.js";
import { speakers } from "./mentions.js";
import { propose } from "../skills/proposals.js";
import { skillCatalog } from "../skills/skills.js";
import { mergeSummary } from "../memory/summary.js";
import { listTools } from "../skills/tools.js";
import { bash, readFile, writeFile } from "../computer/computer.js";
import { accountHome, accountShared } from "../linux/linux.js";

type Db = ReturnType<typeof getDb>;

export type TurnInput = {
  agentId: string;
  provider: string;
  modelId: string;
  system: string;
  prefix: string;
  tail: string;
  promptCacheKey: string;
  messages: { role: "user" | "assistant"; content: string }[];
  accountId: string;
  linuxProfile: string | null;
};

type GenerateResult =
  | string
  | {
      text: string;
      cacheReadTokens?: number | null;
      proposal?: { kind: "memory" | "skill" | "prompt"; body: string; messageIds: string[] };
    };

/**
 * Runs one room turn.
 * Input: database, account id, conversation id, the incoming message, and an optional model call.
 * Output: the replies saved for this turn, one per woken agent, in speaker order.
 * The conversation row stays locked until every reply is saved.
 */
export async function runTurn(
  db: Db,
  accountId: string,
  conversationId: string,
  body: string,
  generate: (input: TurnInput) => Promise<GenerateResult> = (input) => replyWithModel(db, input),
  skillsRoot?: string,
) {
  return db.transaction(async (tx) => {
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
    await tx.insert(messages).values({
      accountId,
      conversationId,
      agentId: null,
      body,
      createdAt: nextTime(),
    });

    const spoken = new Set<string>();
    const queue = speakers(body, memberRows, room.ownerAgentId);
    const replies = [];
    while (queue.length > 0) {
      const agentId = queue.shift();
      if (!agentId || spoken.has(agentId)) {
        continue;
      }
      spoken.add(agentId);
      const [agent] = await tx.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)));
      if (!agent) {
        throw new Error("Agent not found");
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
        tools: listTools([]).map((tool) => tool.name),
        catalog,
      });
      let result: ReturnType<typeof unwrap>;
      try {
        result = unwrap(
        await generate({
          agentId,
          provider: agent.provider,
          modelId: agent.modelId,
          system: context.prefix,
          prefix: context.prefix,
          tail: context.tail,
          promptCacheKey: context.openai.promptCacheKey,
          accountId,
          linuxProfile: agent.linuxProfile,
          messages: history.map((message) => ({
            role: message.agentId ? "assistant" : "user",
            content: message.body,
          })),
        }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        result = {
          text: message.startsWith("Add an API key")
            ? message
            : "The model provider failed. Check the provider key, model id, and endpoint.",
          cacheReadTokens: null,
        };
      }
      const text = result.text.trim();
      const bodyText = text || "The tools finished, but the model sent no message.";
      const [saved] = await tx
        .insert(messages)
        .values({
          accountId,
          conversationId,
          agentId,
          body: bodyText,
          cacheReadTokens: result.cacheReadTokens,
          createdAt: nextTime(),
        })
        .returning();
      replies.push(saved!);
      if (text) {
        await mergeSummary(tx, accountId, conversationId, [{ key: "topics", body: text, messageId: saved!.id }]);
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
    return replies;
  });
}

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
        required: ["path", "body"],
      }),
      execute: async ({ path, body }) => {
        await writeFile(accountId, profile, path, body);
        return "Wrote the file.";
      },
    }),
    bash: tool({
      description: "Run a shell command on your Linux computer. The desktop display is set, so chromium and xterm open on your screen.",
      inputSchema: jsonSchema<{ command: string }>({
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      }),
      execute: async ({ command }) => bash(accountId, profile, command),
    }),
  };
}

function mentioned(body: string, memberRows: { id: string; name: string }[]): string[] {
  return speakers(body, memberRows, "").filter((id) => id !== "");
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
 * Calls the selected provider once.
 * Input: the agent, the cached prefix, the tail, and the recent messages.
 * Output: the reply text and the cache read tokens the provider reported.
 */
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
    messages: input.messages,
  };
}

/**
 * Calls the selected provider once.
 * Input: the agent, the cached prefix, the tail, and the recent messages.
 * Output: the reply text and the cache read tokens the provider reported.
 */
async function replyWithModel(db: Db, input: TurnInput): Promise<GenerateResult> {
  console.log(input)
  console.log("----------------------------------------------------------\n\n\n");
  const credential = await keyFor(db, input.accountId, input.provider);
  const prompt = toModelPrompt(input);
  const profile = input.linuxProfile;
  const result = await generateText({
    model: getModel(input.provider, input.modelId, credential.apiKey, credential.baseUrl),
    instructions: prompt.instructions,
    messages: prompt.messages,
    tools: profile ? linuxTools(input.accountId, profile) : undefined,
    stopWhen: profile ? isStepCount(8) : undefined,
    providerOptions:
      input.provider === "openai"
        ? { openai: { promptCacheKey: input.promptCacheKey, promptCacheRetention: "24h" } }
        : undefined,
  });

  console.log("instructions: ", prompt.instructions);
  console.log("messages: ", prompt.messages);
  console.log('tools: ', profile ? linuxTools(input.accountId, profile) : undefined);
  console.log('stopWhen: ', profile ? isStepCount(8) : undefined);

  console.log('result: ', result);
  return { text: result.text, cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens ?? null };
}
