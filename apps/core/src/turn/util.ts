import { TAIL_MESSAGE_CHARS } from "./constants.js";
import type { GenerateResult, GenerateUsage } from "./types.js";
import type { WorkLogEntry } from "../db/schema.js";

/** Shortens one message for the prompt tail. DB row and recall query keep the full text. */
export function tailSlice(body: string): string {
  if (body.length <= TAIL_MESSAGE_CHARS) return body;
  return `${body.slice(0, TAIL_MESSAGE_CHARS)}…`;
}

export function unwrapGenerateResult(result: GenerateResult): {
  text: string;
  cacheReadTokens: number | null;
  usage?: GenerateUsage;
  quiet?: boolean;
  workLog?: WorkLogEntry[];
  finalTextIsReply?: boolean;
  proposal?: { kind: "memory" | "skill" | "prompt"; body: string; messageIds: string[] };
} {
  if (typeof result === "string") {
    return { text: result, cacheReadTokens: null };
  }
  return { text: result.text, cacheReadTokens: result.cacheReadTokens ?? null, usage: result.usage, quiet: result.quiet, workLog: result.workLog, finalTextIsReply: result.finalTextIsReply, proposal: result.proposal };
}