import { createHash } from "node:crypto";
import { buildAgentIdentity, buildInstructions, type AgentIdentity } from "../prompt/build-instructions.js";

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
 * Why: the prefix (system + identity + optional skills catalog) is byte-stable
 * for provider caching; tool names/schemas live on the AI SDK tools argument,
 * not duplicated here. The tail (room line, summary, messages) changes every turn.
 * Input: account/agent ids, prompt version, identity, summary items, recent
 * messages, optional skills catalog/room.
 * Output: prefix + tail plus provider cache hints.
 */
export function buildContext(input: {
  accountId: string;
  agentId: string;
  promptVersion: number;
  identity: AgentIdentity;
  summary: { key: string; body: string }[];
  messages: { body: string }[];
  catalog?: string;
  room?: { title: string; kind: string; members: string[]; selfName: string };
}): BuiltContext {
  const extras = [...(input.catalog ? [input.catalog] : [])];
  const prefix = [buildInstructions(input.identity), ...extras].join("\n\n");
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
 * Renders the composed identity block for non-turn paths (workers, delegates).
 * Why: single choke point so background prompts match chat prompts exactly.
 * Input: an agent row with role/personality/jobDescription.
 * Output: the identity block text.
 */
export function identityBlock(agent: {
  name: string;
  role: string;
  personality: string;
  jobDescription: string;
}): string {
  return buildAgentIdentity({
    name: agent.name,
    role: agent.role,
    personality: agent.personality ?? "",
    job: agent.jobDescription,
  });
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
