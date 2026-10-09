import { prompt } from "../prompt/prompts.js";

/** Shown after one retry still produced no reply. Text: prompts/dispatcher.md. */
export const stallMessage = (): string => prompt("dispatcher", "stall-message");

/** One user nudge, appended to the same transcript so finished tool work is kept. */
export const stallNudge = (): string => prompt("dispatcher", "stall-nudge");

/**
 * Decides whether the dispatcher gets one more chance to reply.
 * Why: only a truly empty ending (reasoning burned the budget, or tools ran
 * and no text followed) leaves the person silent. Plain text is a valid
 * reply, so wording is never judged here.
 * Input: retries so far, the text, whether a bubble landed, whether the turn ended.
 * Output: true only for the first empty ending.
 */
export function shouldRetryStall(input: {
  attempt: number;
  text: string;
  sentMessage: boolean;
  ended: boolean;
}): boolean {
  if (input.ended || input.sentMessage || input.attempt >= 1) return false;
  return !input.text.trim();
}
