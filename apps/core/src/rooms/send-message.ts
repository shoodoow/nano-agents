import { sendMessageInputSchema, reactionSchema, type MessageBlock } from "@nano-agents/shared";
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { messages, reactions } from "../db/schema.js";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type TurnEvent =
  | { type: "message"; message: typeof messages.$inferSelect }
  | { type: "reaction"; reaction: typeof reactions.$inferSelect }
  | { type: "error"; error: string }
  | { type: "done" };

/**
 * Converts rich blocks to plain text for summaries, FTS, and legacy clients.
 * Why: body stays the searchable/compatible column; payload is the rich source.
 * Materialized attachments render as Linux paths so the agent opens/copies
 * the file on its computer instead of re-emitting base64 through tools.
 * Input: validated MessageBlock array. Output: joined markdown/code/text fallback.
 */
export function blocksToText(blocks: MessageBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === "text") parts.push(block.markdown);
    else if (block.kind === "code") parts.push(block.code);
    else if (block.kind === "image") {
      const at = "savedPath" in block && block.savedPath ? ` (saved at ${block.savedPath})` : "";
      parts.push(block.alt ? `[image: ${block.alt}${at}]` : `[image${at}]`);
    } else if (block.kind === "file") {
      const at = "savedPath" in block && block.savedPath ? ` (saved at ${block.savedPath})` : "";
      parts.push(`[file: ${block.name}${at}]`);
    } else if (block.kind === "widget") parts.push(`[widget:${block.widget}]`);
  }
  return parts.join("\n\n").slice(0, 100_000) || "[attachment]";
}

/**
 * Validates an image block URL.
 * Why: data URIs can blow up rows and prompts; remote URLs can leak SSRF via fetchers.
 * Input: raw url string. Output: true when https URL or small data:image URI.
 */
export function isSafeImageUrl(url: string): boolean {
  if (url.startsWith("data:image/")) {
    return url.length <= 8_000_000 && url.includes(";base64,");
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Saves one send_message emission inside the turn transaction.
 * Why: agent voice must be durable and ordered even if a later tool step fails;
 * buffering alone would lose early bubbles on rollback. Runs in-tx so ordering
 * follows tool-call order via nextTime().
 * Input: tx, ids, validated blocks, optional replyTo/attribution, timestamp fn.
 * Output: the saved message row. Throws on cross-account replyTo or bad image.
 */
export async function saveSendMessage(
  tx: Tx,
  input: {
    accountId: string;
    conversationId: string;
    agentId: string;
    blocks: MessageBlock[];
    replyTo?: string | null;
    viaAgentId?: string | null;
    createdAt: Date;
  },
) {
  const parsed = sendMessageInputSchema.parse({ blocks: input.blocks, replyTo: input.replyTo ?? null });
  for (const block of parsed.blocks) {
    if (block.kind === "image" && !isSafeImageUrl(block.url)) {
      throw new Error("Image must be an https URL or a data:image base64 URI.");
    }
  }
  if (parsed.replyTo) {
    const [parent] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, parsed.replyTo),
          eq(messages.conversationId, input.conversationId),
          eq(messages.accountId, input.accountId),
        ),
      );
    if (!parent) throw new Error("replyTo message is not in this room.");
  }
  const body = blocksToText(parsed.blocks);
  const [saved] = await tx
    .insert(messages)
    .values({
      accountId: input.accountId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      body,
      kind: "rich",
      payload: parsed.blocks,
      replyTo: parsed.replyTo ?? null,
      viaAgentId: input.viaAgentId ?? null,
      createdAt: input.createdAt,
    })
    .returning();
  if (!saved) throw new Error("send_message insert returned no row.");
  return saved;
}

/**
 * Saves one emoji tapback inside the turn transaction.
 * Why: reactions are Grok-style acknowledgements that must not create message
 * noise; unique per (message, user, emoji) so retries are idempotent.
 * Input: tx, account/conversation/agent ids, messageId, emoji.
 * Output: the saved (or existing) reaction row.
 */
export async function saveReaction(
  tx: Tx,
  input: { accountId: string; conversationId: string; agentId: string | null; messageId: string; emoji: string },
) {
  const parsed = reactionSchema.parse({ messageId: input.messageId, emoji: input.emoji });
  const [parent] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.id, parsed.messageId),
        eq(messages.conversationId, input.conversationId),
        eq(messages.accountId, input.accountId),
      ),
    );
  if (!parent) throw new Error("Reaction target is not in this room.");
  const userKey = input.agentId ?? "owner";
  const [existing] = await tx
    .select()
    .from(reactions)
    .where(and(eq(reactions.messageId, parsed.messageId), eq(reactions.userKey, userKey), eq(reactions.emoji, parsed.emoji)));
  if (existing) return existing;
  const [saved] = await tx
    .insert(reactions)
    .values({
      accountId: input.accountId,
      messageId: parsed.messageId,
      agentId: input.agentId,
      userKey,
      emoji: parsed.emoji,
    })
    .returning();
  if (!saved) throw new Error("Reaction insert returned no row.");
  return saved;
}
