import { memberAddSchema, messageCreateSchema, roomCreateSchema, sendMessageInputSchema } from "@nano-agents/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, conversations, members, messages, reactions } from "../db/schema.js";
import { materializeBlocks } from "./uploads.js";

type Database = ReturnType<typeof getDb>;

export class RoomCapacityError extends Error {
  constructor() {
    super("A room cannot have more than 20 members");
    this.name = "RoomCapacityError";
  }
}

/**
 * Opens a direct chat or a group inside one account.
 * Input: a database client, the account id, and the room kind, title, owner, and member ids.
 * Output: the saved conversation and its members, or null when an agent is outside the account.
 */
export async function createRoom(db: Database, accountId: string, input: unknown) {
  const data = roomCreateSchema.parse(input);
  const agentIds = [...new Set([data.ownerAgentId, ...data.memberAgentIds])];
  if (agentIds.length > 20) {
    throw new RoomCapacityError();
  }
  const owned = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.accountId, accountId), inArray(agents.id, agentIds)));
  if (owned.length !== agentIds.length) {
    return null;
  }
  return db.transaction(async (tx) => {
    const [room] = await tx
      .insert(conversations)
      .values({
        accountId,
        kind: data.kind,
        ownerAgentId: data.ownerAgentId,
        title: data.title,
      })
      .returning();
    if (!room) {
      throw new Error("The room insert returned no row.");
    }
    const roomMembers = await tx
      .insert(members)
      .values(agentIds.map((agentId) => ({ conversationId: room.id, accountId, agentId })))
      .returning();
    return { ...room, members: roomMembers };
  });
}

/**
 * Adds one agent to a room that this account owns.
 * Input: a database client, the account id, the conversation id, and a body with an agent id.
 * Output: the saved member, or null when the room or agent is outside the account.
 */
export async function addMember(db: Database, accountId: string, conversationId: string, input: unknown) {
  const data = memberAddSchema.parse(input);
  const [room] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  if (!room) {
    return null;
  }
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, data.agentId), eq(agents.accountId, accountId)));
  if (!agent) {
    return null;
  }
  const existing = await db
    .select({ agentId: members.agentId })
    .from(members)
    .where(and(eq(members.conversationId, conversationId), eq(members.accountId, accountId)));
  if (existing.some((member) => member.agentId === data.agentId)) {
    return existing.find((member) => member.agentId === data.agentId) ?? null;
  }
  if (existing.length >= 20) {
    throw new RoomCapacityError();
  }
  const [row] = await db
    .insert(members)
    .values({ conversationId, accountId, agentId: data.agentId })
    .returning();
  return row ?? null;
}

/**
 * Reads one user message for a room this account owns.
 * Why: accepts legacy {body} and new {blocks, replyTo}; returns text for the
 * turn engine plus rich passthrough so user-sent images render like agent ones.
 * Input: unknown JSON. Output: {text, blocks?, replyTo?}, or null outside account.
 */
export async function readMessage(db: Database, accountId: string, conversationId: string, input: unknown) {
  const [room] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  if (!room) {
    return null;
  }
  if (typeof input === "object" && input !== null && "blocks" in input) {
    const rich = sendMessageInputSchema.parse(input);
    const text = rich.blocks
      .map((block) =>
        block.kind === "text" ? block.markdown : block.kind === "code" ? block.code : `[${block.kind}]`,
      )
      .join("\n\n");
    return { text, blocks: rich.blocks, replyTo: rich.replyTo ?? null };
  }
  const data = messageCreateSchema.parse(input);
  return { text: data.body, blocks: null, replyTo: null };
}

/**
 * Lists the chats on one account.
 * Input: a database client and the account id.
 * Output: that account's conversations. Another account's rooms are omitted.
 */
export async function listConversations(db: Database, accountId: string) {
  return db
    .select({
      id: conversations.id,
      kind: conversations.kind,
      title: conversations.title,
      ownerAgentId: conversations.ownerAgentId,
    })
    .from(conversations)
    .where(eq(conversations.accountId, accountId));
}

/**
 * Saves one user message synchronously (outside the turn transaction).
 * Why: POST /messages used to insert the user text inside the background
 * runTurn, so the phone's safety refresh could run before the insert and wipe
 * the optimistic bubble — the message "vanished". Durable-first ordering
 * (insert, then 202 + background turn) makes the message impossible to lose:
 * every later refresh finds it.
 * Input: db, account/conversation ids, {text, blocks?, replyTo?}.
 * Output: the saved row, or null when the room is outside the account.
 */
export async function saveUserMessage(
  db: Database,
  accountId: string,
  conversationId: string,
  input: { text: string; blocks?: { kind: string; [key: string]: unknown }[] | null; replyTo?: string | null },
) {
  const [room] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  if (!room) {
    return null;
  }
  if (input.replyTo) {
    const [parent] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.replyTo),
          eq(messages.conversationId, conversationId),
          eq(messages.accountId, accountId),
        ),
      );
    if (!parent) {
      throw new Error("replyTo message is not in this room.");
    }
  }
  const [saved] = await db
    .insert(messages)
    .values({
      accountId,
      conversationId,
      agentId: null,
      body: input.text,
      kind: input.blocks && input.blocks.length > 0 ? "rich" : "text",
      payload: input.blocks && input.blocks.length > 0 ? input.blocks : null,
      replyTo: input.replyTo ?? null,
    })
    .returning();
  if (!saved) {
    throw new Error("The message insert returned no row.");
  }
  // Land attachments on the account Linux before anyone reads the thread: the
  // agent then works with /shared/uploads paths instead of megabytes of
  // base64. Best-effort — a computer outage degrades to inline blocks, and
  // the message itself is already durable so nothing is lost.
  if (input.blocks && input.blocks.length > 0) {
    try {
      const landed = await materializeBlocks(accountId, saved.id, input.blocks as never);
      const changed = JSON.stringify(landed) !== JSON.stringify(input.blocks);
      if (changed) {
        const [updated] = await db
          .update(messages)
          .set({ payload: landed as never })
          .where(and(eq(messages.id, saved.id), eq(messages.accountId, accountId)))
          .returning();
        if (updated) return updated;
      }
    } catch {
      // Computer unavailable; inline blocks still carry the content.
    }
  }
  return saved;
}
/**
 * Lists the saved messages in one room with rich payloads.
 * Why: the phone renders blocks/images/widgets inline; body stays as text
 * fallback for search and legacy clients. Reactions are fetched separately to
 * keep the hot path small.
 * Input: a database client, the account id, and the conversation id.
 * Output: the messages in time order with kind/payload/replyTo/via, or null outside account.
 */
export async function listMessages(db: Database, accountId: string, conversationId: string) {
  const [room] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  if (!room) {
    return null;
  }
  return db
    .select({
      id: messages.id,
      agentId: messages.agentId,
      body: messages.body,
      kind: messages.kind,
      payload: messages.payload,
      replyTo: messages.replyTo,
      viaAgentId: messages.viaAgentId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)))
    .orderBy(asc(messages.createdAt));
}

/**
 * Lists tapbacks for messages in one room.
 * Why: reactions render under bubbles without re-fetching threads.
 * Input: db, account id, conversation id. Output: reactions in time order.
 */
export async function listReactions(db: Database, accountId: string, conversationId: string) {
  const messageIds = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)));
  if (messageIds.length === 0) return [];
  const ids = messageIds.map((m) => m.id);
  return db
    .select()
    .from(reactions)
    .where(and(eq(reactions.accountId, accountId), inArray(reactions.messageId, ids)))
    .orderBy(asc(reactions.createdAt));
}
