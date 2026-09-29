import { createHash } from "node:crypto";
import { buildInstructions } from "../prompt/build-instructions.js";

const keyOrder = ["decisions", "actions", "open", "entities", "corrections", "topics"];

export type BuiltContext = {
  prefix: string;
  tail: string;
  anthropic: {
    prefix: { cacheControl: { type: "ephemeral" } };
    tail: { body: string };
  };
  openai: {
    promptCacheKey: string;
    promptCacheRetention: "24h";
  };
};

/**
 * Splits one turn into a cacheable prefix and an append-only tail.
 * Input: the account, agent, prompt version, description, summary items,
 * recent messages, and the optional room situation (group name, members, self).
 * Output: the standing prompt, the sorted tool names, and the skill catalog as the prefix. The room line, summary, and messages are the tail. Anthropic cache control is on the prefix only. The OpenAI cache key is the account, the agent, and the prompt version.
 */
export function buildContext(input: {
  accountId: string;
  agentId: string;
  promptVersion: number;
  description: string;
  summary: { key: string; body: string }[];
  messages: { body: string }[];
  tools?: string[];
  catalog?: string;
  room?: { title: string; kind: string; members: string[]; selfName: string };
}): BuiltContext {
  const extras = [
    ...(input.tools && input.tools.length > 0 ? [[...input.tools].sort().join("\n")] : []),
    ...(input.catalog ? [input.catalog] : []),
  ];
  const prefix = [buildInstructions(input.description), ...extras].join("\n\n");
  const summaryLines = [...input.summary].sort(
    (left, right) => keyOrder.indexOf(left.key) - keyOrder.indexOf(right.key) || left.body.localeCompare(right.body),
  );
  const tail = [
    ...(input.room ? [roomLine(input.room)] : []),
    ...summaryLines.map((item) => `${item.key}: ${item.body}`),
    ...input.messages.map((message) => message.body),
  ].join("\n");
  return {
    prefix,
    tail,
    anthropic: {
      prefix: { cacheControl: { type: "ephemeral" } },
      tail: { body: tail },
    },
    openai: {
      promptCacheKey: cacheKey(input.accountId, input.agentId, input.promptVersion),
      promptCacheRetention: "24h",
    },
  };
}

/**
 * Renders the room situation as the first tail line.
 * Why: without it the model does not know the room name, who shares it, or
 * which member it is — the exact confusion behind "Looks like you're asking
 * @Jimmy" written BY Jimmy. One factual line grounds identity, roster, and
 * the @mention rule every turn. Lives in the tail (dynamic), never the
 * cached prefix.
 * Input: room title/kind, member names, own name. Output: one header line.
 */
export function roomLine(room: { title: string; kind: string; members: string[]; selfName: string }): string {
  const members = room.members.length > 0 ? room.members.join(", ") : "—";
  const shape = room.kind === "group" ? `group of ${room.members.length}` : "direct chat";
  return `Room "${room.title}" (${shape}). Members: ${members}. You are ${room.selfName} — reply only when mentioned; members wake each other with @Name, a leading @Name is a direct handoff to that member.`;
}

function cacheKey(accountId: string, agentId: string, promptVersion: number): string {
  const raw = `${accountId}:${agentId}:${promptVersion}`;
  if (raw.length <= 64) {
    return raw;
  }
  return createHash("sha256").update(raw).digest("hex");
}
