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
  /** Room kind for tool filtering (direct chats get a slim set). Set by speaker. */
  roomKind?: string;
  /** Per-turn spawn guard: mutated by executors. Caps retry-burn. */
  spawnCount?: number;
  /**
   * Recent tool calls this turn (name + JSON input), mutated by the registry
   * wrapper. Powers the generic doom-loop detector: 3 identical calls in a
   * row never execute — the model gets a stop error instead.
   */
  recentCalls?: { name: string; input: string }[];
  /** Linux username for cheap parent tools (read/search/fetch). */
  linuxProfile?: string | null;
  /** Stop the model loop after this tool (secret-request). */
  endTurn?: boolean;
  /** Agent id that should speak Auto-review cards (parent when a worker is blocked). */
  voiceAgentId?: string;
};
