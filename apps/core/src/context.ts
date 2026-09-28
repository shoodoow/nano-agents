import { buildInstructions } from "./build-instructions.js";

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
 * Output: the standing prompt as the prefix, the summary and messages as the tail, Anthropic cache control on the prefix only, and an OpenAI cache key.
 */
export function buildContext(input: {
  accountId: string;
  agentId: string;
  promptVersion: number;
  description: string;
  summary: { key: string; body: string }[];
  messages: { body: string }[];
}): BuiltContext {
  const prefix = buildInstructions(input.description);
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
      promptCacheKey: `${input.accountId}:${input.agentId}:${input.promptVersion}`,
      promptCacheRetention: "24h",
    },
  };
}
