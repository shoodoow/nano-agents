import type { GenerateResult } from "./types.js";

export function unwrapGenerateResult(result: GenerateResult): {
  text: string;
  cacheReadTokens: number | null;
  proposal?: { kind: "memory" | "skill" | "prompt"; body: string; messageIds: string[] };
} {
  if (typeof result === "string") {
    return { text: result, cacheReadTokens: null };
  }
  return { text: result.text, cacheReadTokens: result.cacheReadTokens ?? null, proposal: result.proposal };
}
