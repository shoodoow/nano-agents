/**
 * Per-turn tool execution context.
 * Why: handlers stay pure; registry adds trace + timing. DB: handlers touch messages, delegations, etc.
 */
import type { getDb, Store } from "../../db/client.js";
import type { messages } from "../../db/schema.js";
import type { TurnEvent } from "../../rooms/send-message.js";
import type { TraceSession } from "../trace/plugins.js";
import type { GenerateResult, TurnInput } from "../types.js";

type Db = ReturnType<typeof getDb>;

export type ToolContext = {
  db: Db;
  store: Store;
  accountId: string;
  conversationId: string;
  agentId: string;
  runId: string;
  skillsRoot?: string;
  nextTime: () => Date;
  emittedMessages: (typeof messages.$inferSelect)[];
  emit: (event: TurnEvent) => Promise<void>;
  viaAgentId?: string | null;
  delegationDepth?: number;
  traceSession?: TraceSession;
  generate?: (input: TurnInput) => Promise<GenerateResult>;
};
