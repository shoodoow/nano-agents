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
import { runModelHarness } from "./trace/harness.js";
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
  const { text, cacheReadTokens, usage } = await runModelHarness({
    ...input,
    db,
    mode,
    tools,
    traceSession,
    shouldStop: () => Boolean(toolCtx.endTurn),
  });
  return { text, cacheReadTokens, usage };
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
