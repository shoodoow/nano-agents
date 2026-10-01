/**
 * Shared turn-engine types.
 * Why: one import surface for orchestrator, speaker, agent loop, and tests.
 * DB: types only — no persistence here.
 */
import type { StreamEvent } from "../rooms/stream.js";
import type { TurnMessageContent } from "./prompt-media.js";

export type { TurnImagePart, TurnMessageContent } from "./prompt-media.js";

export type TurnInput = {
  agentId: string;
  provider: string;
  modelId: string;
  system: string;
  prefix: string;
  tail: string;
  promptCacheKey: string;
  messages: { role: "user" | "assistant"; content: TurnMessageContent }[];
  accountId: string;
  linuxProfile: string | null;
};

export type TurnOptions = {
  onEvent?: (event: StreamEvent) => void;
  alreadySavedUserMessage?: { id: string; text: string };
  existingRunId?: string;
  kind?: "turn" | "routine";
  cue?: string;
  speakerId?: string;
  acquireTimeoutMs?: number;
};

export type GenerateResult =
  | string
  | {
      text: string;
      cacheReadTokens?: number | null;
      proposal?: { kind: "memory" | "skill" | "prompt"; body: string; messageIds: string[] };
    };

export type AgentMode = "dispatcher" | "worker" | "delegate";
