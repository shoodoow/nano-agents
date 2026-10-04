/**
 * Coerces common model mistakes into send_message input before Zod parse.
 * Why: providers sometimes flatten blocks, stringify the array, or dump a
 * `[widget:secret {…}]` line as markdown instead of a real widget block.
 */
import { expandWidgetMarkupBlocks } from "@nano-agents/shared";

export function normalizeSendMessageInput(input: Record<string, unknown>): { blocks: unknown; replyTo?: unknown } {
  let blocks = input.blocks;
  let replyTo = input.replyTo;

  if (blocks === undefined && typeof input.kind === "string") {
    const { replyTo: rt, kind, ...rest } = input;
    blocks = [{ kind, ...rest }];
    if (replyTo === undefined && rt !== undefined) replyTo = rt;
  }

  if (typeof blocks === "string") {
    try {
      blocks = JSON.parse(blocks) as unknown;
    } catch {
      blocks = [{ kind: "text", markdown: blocks }];
    }
  }

  if (blocks !== null && typeof blocks === "object" && !Array.isArray(blocks)) {
    const obj = blocks as Record<string, unknown>;
    if (typeof obj.kind === "string") {
      blocks = [obj];
    }
  }

  if (Array.isArray(blocks)) {
    blocks = expandWidgetMarkupBlocks(blocks).map((block) => {
      if (!block || typeof block !== "object") return block;
      const row = block as { kind?: string; markdown?: string };
      if (row.kind === "text" && typeof row.markdown === "string") {
        return { ...row, markdown: stripInternalChatMarks(row.markdown) };
      }
      return block;
    });
  }

  return { blocks, replyTo: replyTo ?? null };
}

/** Drops message-id citations and worker report labels the person should not see. */
export function stripInternalChatMarks(markdown: string): string {
  return markdown
    .replace(/^\s*\[msg:[^\]]+\]\s*/i, "")
    .replace(/\n\s*\[msg:[^\]]+\]\s*/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*\*{0,2}(Findings|What I did|Blockers)\*{0,2}\s*:\s*/i, ""))
    .join("\n")
    .trim();
}
