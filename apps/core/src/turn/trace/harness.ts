/**
 * Single AI SDK entry: generateText + trace events.
 * Why: every dispatcher/worker/delegate model call is inspectable via TracePlugin.
 * DB: none (tools write via registry).
 */
import { generateText, isStepCount, type ToolSet } from "ai";
import { getModel, usesOfficialOpenAiEndpoint } from "../../model/get-model.js";
import { keyFor } from "../../keys/keys.js";
import type { getDb } from "../../db/client.js";
import { toModelPrompt } from "../prompt-model.js";
import type { TurnInput } from "../types.js";
import { MAX_MODEL_STEPS_DISPATCHER } from "../constants.js";
import { createTraceSession, type TraceSession } from "./plugins.js";
import { tracePreview } from "./sinks/jsonl.js";
import type { AgentMode } from "../types.js";
import { randomUUID } from "node:crypto";

type Db = ReturnType<typeof getDb>;

export type RunModelInput = TurnInput & {
  db: Db;
  conversationId: string;
  runId: string;
  mode: AgentMode;
  tools: ToolSet;
  delegationId?: string;
  maxSteps?: number;
  /** When set, harness reuses this session (tools emit into the same trace). */
  traceSession?: TraceSession;
};

export async function runModelHarness(
  input: RunModelInput,
): Promise<{ text: string; cacheReadTokens: number | null; session: TraceSession }> {
  const credential = await keyFor(input.db, input.accountId, input.provider);
  const prompt = toModelPrompt(input);
  const traceId = randomUUID();
  const session =
    input.traceSession ??
    createTraceSession({
      traceId,
      runId: input.runId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      mode: input.mode,
      provider: input.provider,
      modelId: input.modelId,
      delegationId: input.delegationId,
    });

  const toolNames = Object.keys(input.tools).sort();
  await session.emit({
    type: "run.start",
    prefix: input.prefix,
    tail: input.tail,
    promptCacheKey: input.promptCacheKey,
    toolNames,
    instructions: prompt.instructions,
    modelMessages: prompt.messages,
  });

  let stepIndex = 0;
  try {
    const result = await generateText({
      model: getModel(input.provider, input.modelId, credential.apiKey, credential.baseUrl),
      instructions: prompt.instructions,
      messages: prompt.messages,
      tools: input.tools,
      stopWhen: isStepCount(input.maxSteps ?? MAX_MODEL_STEPS_DISPATCHER),
      providerOptions: usesOfficialOpenAiEndpoint(input.provider, credential.baseUrl)
        ? { openai: { promptCacheKey: input.promptCacheKey, promptCacheRetention: "24h" } }
        : undefined,
      onStepFinish: async (step) => {
        stepIndex += 1;
        const usage = step.usage
          ? {
              inputTokens: step.usage.inputTokens,
              outputTokens: step.usage.outputTokens,
              cacheReadTokens: step.usage.inputTokenDetails?.cacheReadTokens,
              reasoningTokens: step.usage.outputTokenDetails?.reasoningTokens,
            }
          : undefined;
        const toolCalls = (step.toolCalls ?? []).map((call) => {
          const toolCallId = (call as { toolCallId?: string }).toolCallId ?? randomUUID();
          const name = (call as { toolName?: string }).toolName ?? "unknown";
          const toolInput = (call as { input?: unknown }).input ?? (call as { args?: unknown }).args ?? null;
          return { toolCallId, name, input: toolInput };
        });
        const toolResults = (step.toolResults ?? []).map((r) => {
          const toolCallId = (r as { toolCallId?: string }).toolCallId ?? "";
          const name = (r as { toolName?: string }).toolName ?? "unknown";
          const raw = (r as { output?: unknown }).output ?? (r as { result?: unknown }).result ?? null;
          const output =
            raw && typeof raw === "object" && "value" in (raw as Record<string, unknown>)
              ? (raw as { value: unknown }).value
              : raw;
          return { toolCallId, name, outputPreview: tracePreview(output ?? "(no result yet)") };
        });
        await session.emit({
          type: "model.step.finish",
          step: stepIndex,
          text: (step.text ?? "").slice(0, 300),
          usage,
          toolCalls,
          toolResults,
        });
      },
    });

    const usage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.inputTokenDetails?.cacheReadTokens ?? undefined,
      reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens,
    };
    await session.emit({
      type: "run.finish",
      text: result.text,
      usage,
      steps: stepIndex,
    });

    return {
      text: result.text,
      cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens ?? null,
      session,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Model failed.";
    await session.emit({ type: "run.error", phase: "model", message });
    throw error;
  }
}
