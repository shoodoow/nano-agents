/**
 * Dispatcher/delegate model loop — only entry to runModelHarness for chat agents.
 * DB: none directly; tools persist via registry executors.
 */
import type { getDb, Store } from "../db/client.js";
import type { TurnEvent } from "../rooms/send-message.js";
import { messages } from "../db/schema.js";
import type { AgentMode, GenerateResult, TurnInput } from "./types.js";
import { ensureTracePlugins } from "./trace/bootstrap.js";
import { createTraceSession } from "./trace/plugins.js";
import { runModelHarness, type HarnessUsage } from "./trace/harness.js";
import { shouldRetryStall, STALL_NUDGE } from "./narration-stall.js";
import { randomUUID } from "node:crypto";
import { buildFullToolSet } from "./tools/registry.js";
import type { ToolContext } from "./tools/context.js";

type Db = ReturnType<typeof getDb>;

export async function runAgentLoop(
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
    mode?: AgentMode;
    generate?: (input: TurnInput) => Promise<GenerateResult>;
  },
): Promise<GenerateResult> {
  ensureTracePlugins();
  const mode = input.mode ?? "dispatcher";
  const traceSession = createTraceSession({
    traceId: randomUUID(),
    runId: input.runId,
    accountId: input.accountId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    mode,
    provider: input.provider,
    modelId: input.modelId,
  });
  const toolCtx: ToolContext = {
    db,
    store,
    accountId: input.accountId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    runId: input.runId,
    skillsRoot: input.skillsRoot,
    nextTime: input.nextTime,
    emittedMessages: input.emittedMessages,
    emit: input.emit,
    viaAgentId: input.viaAgentId ?? null,
    delegationDepth: input.delegationDepth,
    generate: input.generate,
    traceSession,
    linuxProfile: input.linuxProfile,
    voiceAgentId: input.agentId,
  };
  const tools = await buildFullToolSet(mode, toolCtx);
  const harnessInput = {
    ...input,
    db,
    mode,
    tools,
    traceSession,
    shouldStop: () => Boolean(toolCtx.endTurn),
  };
  let { text, cacheReadTokens, usage } = await runModelHarness(harnessInput);
  if (
    mode === "dispatcher" &&
    shouldRetryStall({
      attempt: 0,
      text,
      sentMessage: input.emittedMessages.length > 0,
      ended: Boolean(toolCtx.endTurn),
    })
  ) {
    const retry = await runModelHarness({
      ...harnessInput,
      messages: [...input.messages, { role: "user", content: STALL_NUDGE }],
    });
    text = retry.text;
    cacheReadTokens = retry.cacheReadTokens;
    usage = addUsage(usage, retry.usage);
  }
  return { text, cacheReadTokens, usage };
}

function addUsage(left: HarnessUsage, right: HarnessUsage): HarnessUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: addNullable(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: addNullable(left.cacheWriteTokens, right.cacheWriteTokens),
    reasoningTokens: addNullable(left.reasoningTokens, right.reasoningTokens),
    steps: left.steps + right.steps,
  };
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

/** Legacy single-shot path for tests that bypass tools. */
export async function replyWithModel(db: Db, input: TurnInput): Promise<GenerateResult> {
  ensureTracePlugins();
  const { text, cacheReadTokens, usage } = await runModelHarness({
    ...input,
    db,
    conversationId: "",
    runId: "",
    mode: "dispatcher",
    tools: {},
    maxSteps: 1,
  });
  return { text, cacheReadTokens, usage };
}
