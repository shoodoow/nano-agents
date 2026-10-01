import type { AgentMode } from "../types.js";

export type TraceContext = {
  traceId: string;
  runId: string;
  accountId: string;
  conversationId: string;
  agentId: string;
  mode: AgentMode;
  provider: string;
  modelId: string;
  delegationId?: string;
};

export type TraceUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
};

export type TraceEvent =
  | {
      type: "run.start";
      prefix: string;
      tail: string;
      promptCacheKey: string;
      toolNames: string[];
      /** AI SDK system instructions (cached prefix + tail). */
      instructions: unknown;
      /** Conversation messages passed to the model for this run. */
      modelMessages: unknown;
    }
  | {
      type: "model.step.finish";
      step: number;
      text: string;
      usage?: TraceUsage;
      toolCalls: { toolCallId: string; name: string; input: unknown }[];
      toolResults: { toolCallId: string; name: string; outputPreview: string }[];
    }
  | { type: "tool.call.start"; toolCallId: string; name: string; input: unknown }
  | {
      type: "tool.call.finish";
      toolCallId: string;
      name: string;
      input: unknown;
      outputPreview: string;
      durationMs: number;
      error?: string;
    }
  | { type: "run.finish"; text: string; usage?: TraceUsage; steps: number }
  | { type: "run.error"; phase: "model" | "tool"; message: string };
