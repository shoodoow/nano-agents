import { NEXT_STEP_NARRATION } from "./worker-report.js";

/** Dispatcher bubbles longer than this are a planning loop, not a reply. */
export const STALL_CHAR_CAP = 1_200;

/** Shown after one retry still produced no send_message. */
export const STALL_MESSAGE = "I didn’t finish that. Tell me to try again.";

/** One user nudge. The loop text is not sent back with it. */
export const STALL_NUDGE =
  "Call send_message now with a short update for the person. Do not describe the plan. Do not end with empty text.";

/**
 * True when assistant text is a plan instead of a reply.
 * Why: a cheap model writes "I'll list everything" and never calls a tool.
 * Input: the model's plain text. Output: whether that text is a stall.
 */
export function isNarrationStall(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > STALL_CHAR_CAP) return true;
  return NEXT_STEP_NARRATION.test(trimmed);
}

/**
 * Decides whether the dispatcher may try the tool call once more.
 * Why: empty replies (reasoning burned the budget) and narration stalls both
 * leave the person silent — one nudge recovers most of them.
 * Input: how many retries already ran, the text, whether send_message landed, and whether the turn ended.
 * Output: true only for the first stall.
 */
export function shouldRetryStall(input: {
  attempt: number;
  text: string;
  sentMessage: boolean;
  ended: boolean;
}): boolean {
  if (input.ended || input.sentMessage || input.attempt >= 1) return false;
  if (!input.text.trim()) return true;
  return isNarrationStall(input.text);
}
