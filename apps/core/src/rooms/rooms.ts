import { memberAddSchema, messageCreateSchema, roomCreateSchema } from "@nano-agents/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, conversations, members, messages } from "../db/schema.js";

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
 * Reads one message body for a room this account owns.
 * Input: unknown JSON. Output: the message text, or null when the room is outside the account.
 */
export async function readMessage(db: Database, accountId: string, conversationId: string, input: unknown) {
  const data = messageCreateSchema.parse(input);
  const [room] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)));
  if (!room) {
    return null;
  }
  return data.body;
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
 * Lists the saved messages in one room.
 * Input: a database client, the account id, and the conversation id.
 * Output: the messages in time order, or null when the room is outside the account.
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
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, accountId)))
    .orderBy(asc(messages.createdAt));
}
