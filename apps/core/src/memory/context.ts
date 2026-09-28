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
 * Input: the account, agent, prompt version, description, summary items, and recent messages.
 * Output: the standing prompt, the sorted tool names, and the skill catalog as the prefix. The summary and messages are the tail. Anthropic cache control is on the prefix only. The OpenAI cache key is the account, the agent, and the prompt version.
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
}): BuiltContext {
  const extras = [
    ...(input.tools && input.tools.length > 0 ? [[...input.tools].sort().join("\n")] : []),
    ...(input.catalog ? [input.catalog] : []),
  ];
  const prefix = [buildInstructions(input.description), ...extras].join("\n\n");
  const summaryLines = [...input.summary].sort(
    (left, right) => keyOrder.indexOf(left.key) - keyOrder.indexOf(right.key) || left.body.localeCompare(right.body),
  );
  const tail = [...summaryLines.map((item) => `${item.key}: ${item.body}`), ...input.messages.map((message) => message.body)].join(
    "\n",
  );
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

function cacheKey(accountId: string, agentId: string, promptVersion: number): string {
  const raw = `${accountId}:${agentId}:${promptVersion}`;
  if (raw.length <= 64) {
    return raw;
  }
  return createHash("sha256").update(raw).digest("hex");
}
