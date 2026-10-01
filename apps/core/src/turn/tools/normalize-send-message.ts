/**
 * Coerces common model mistakes into send_message input before Zod parse.
 * Why: providers sometimes flatten blocks or stringify the array despite JSON Schema.
 */
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

  return { blocks, replyTo: replyTo ?? null };
}
