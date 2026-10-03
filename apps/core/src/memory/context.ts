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
 * work history, optional skills catalog/room. Recent chat messages are sent
 * through the model message channel and are deliberately not duplicated here.
 * Output: prefix + tail plus provider cache hints.
 */
export function buildContext(input: {
  accountId: string;
  agentId: string;
  promptVersion: number;
  identity: AgentIdentity;
  summary: { key: string; body: string; messageId?: string }[];
  messages: { body: string }[];
  memories?: { body: string }[];
  recall?: string[];
  catalog?: string;
  room?: { title: string; kind: string; members: string[]; selfName: string };
  activeWorkers?: {
    childAgentId: string;
    label?: string | null;
    task: string;
    progress?: string | null;
    createdAt?: Date | null;
  }[];
  workHistory?: { kind: "worker" | "routine"; title: string; outcome: string; status: string; createdAt: Date }[];
}): BuiltContext {
  const extras = [...(input.catalog ? [input.catalog] : [])];
  const prefix = [buildInstructions(input.identity), ...extras].join("\n\n");
  const summaryLines = [...input.summary].sort(
    (left, right) => keyOrder.indexOf(left.key) - keyOrder.indexOf(right.key) || left.body.localeCompare(right.body),
  );
  const memoryBlock = memorySection(input.memories ?? []);
  const recallBlock = recallSection(input.recall ?? []);
  const workersBlock = activeWorkersSection(input.activeWorkers ?? []);
  const workBlock = workHistorySection(input.workHistory ?? []);
  const tail = [
    ...(input.room ? [roomLine(input.room)] : []),
    ...(memoryBlock ? [memoryBlock] : []),
    ...(recallBlock ? [recallBlock] : []),
    ...(workersBlock ? [workersBlock] : []),
    ...(workBlock ? [workBlock] : []),
    ...summaryLines.map((item) => `${item.key}: ${item.body}${item.messageId ? ` [msg:${item.messageId}]` : ""}`),
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

/**
 * Renders durable facts as a standing memory block in the tail.
 * Why: remembered facts (user + this agent's own) must re-enter the model's
 * context every turn or the agent "forgets" across a long-running thread. They
 * live in the dynamic tail, not the cached prefix, because they change as the
 * agent learns and corrects. Empty input renders nothing.
 * Input: the facts to surface. Output: a labeled block, or empty string.
 */
function memorySection(memories: { body: string }[]): string {
  if (memories.length === 0) {
    return "";
  }
  return ["Memory (durable facts — trust these):", ...memories.map((memory) => `- ${memory.body}`)].join("\n");
}

/**
 * Renders the semantically-recalled slice of older context in the tail.
 * Why: on a long thread the relevant past is pulled back by similarity rather
 * than scrolling the whole transcript, so the agent stays sharp without the
 * window growing. Empty input renders nothing.
 */
function recallSection(recall: string[]): string {
  if (recall.length === 0) {
    return "";
  }
  return ["Recalled from earlier in this thread:", ...recall.map((line) => `- ${line}`)].join("\n");
}

/**
 * Renders currently running background workers in the tail.
 * Why: The dispatcher must know what background tasks are already executing so it:
 * 1) Remains available to converse with the user while tasks run.
 * 2) Knows what's in-flight to report status or acknowledge work in progress.
 * 3) Can redirect or stop active workers rather than spawning duplicates.
 * Lives in the dynamic tail so the prefix cache remains byte-stable.
 */
export function activeWorkersSection(
  workers: {
    childAgentId: string;
    label?: string | null;
    task: string;
    progress?: string | null;
    createdAt?: Date | null;
  }[],
): string {
  if (workers.length === 0) {
    return "";
  }
  const items = workers
    .map((w) => {
      const elapsed = w.createdAt
        ? `${Math.max(0, Math.round((Date.now() - w.createdAt.getTime()) / 1000))}s ago`
        : "recently";
      const name = w.label?.trim() || w.childAgentId;
      const progress = w.progress?.trim() ? `, latest: "${w.progress.slice(0, 180)}"` : "";
      return `Worker ${name} [${w.childAgentId}] (started ${elapsed}, task: "${w.task.slice(0, 80)}"${progress})`;
    })
    .join(" | ");
  return `Active background workers: ${items}. You are available to chat with the user while workers run. If the user asks for status, report what is in flight. If the user clarifies or changes task, use redirect_worker. If the user cancels, use stop_worker. Never spawn duplicate workers for jobs already running.`;
}

/**
 * Renders a bounded cross-thread record of the employee's recent work.
 * Why: a long-lived CMO must remember what its workers and routines actually
 * accomplished without replaying old chats or injecting raw execution logs.
 * Input: recent completed work selected by the caller. Output: a concise,
 * labeled block in newest-first order.
 */
export function workHistorySection(
  history: { kind: "worker" | "routine"; title: string; outcome: string; status: string; createdAt: Date }[],
): string {
  if (history.length === 0) return "";
  const lines = history.slice(0, 8).map((item) => {
    const date = item.createdAt.toISOString();
    const title = item.title.replace(/\s+/g, " ").trim().slice(0, 120);
    const outcome = item.outcome.replace(/\s+/g, " ").trim().slice(0, 300);
    return `- ${date} ${item.kind} ${item.status}: ${title}${outcome ? ` — ${outcome}` : ""}`;
  });
  return ["Recent work memory (your own jobs across chats):", ...lines].join("\n");
}


function cacheKey(accountId: string, agentId: string, promptVersion: number): string {
  const raw = `${accountId}:${agentId}:${promptVersion}`;
  if (raw.length <= 64) {
    return raw;
  }
  return createHash("sha256").update(raw).digest("hex");
}
