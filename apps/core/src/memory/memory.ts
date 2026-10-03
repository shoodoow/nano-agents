import { memoryCorrectSchema, memoryFactSchema } from "@nano-agents/shared";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { memories, messages } from "../db/schema.js";

type Database = Pick<ReturnType<typeof getDb>, "insert" | "select" | "delete">;

const pageSize = 5;
const standingMemoryLimit = 24;

/**
 * Loads one cited message, or a short search page from one room.
 * Input: database, account id, conversation id, and either a message id or a search string.
 * Output: the matching messages, never the whole transcript. Search returns at most five rows.
 */
export async function readHistory(
  db: Database,
  accountId: string,
  conversationId: string,
  query: { messageId: string } | { search: string; limit?: number },
) {
  if ("messageId" in query) {
    return db
      .select()
      .from(messages)
      .where(
        and(eq(messages.accountId, accountId), eq(messages.conversationId, conversationId), eq(messages.id, query.messageId)),
      );
  }
  const limit = Math.min(query.limit ?? pageSize, pageSize);
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        eq(messages.conversationId, conversationId),
        sql`to_tsvector('english', ${messages.body}) @@ plainto_tsquery('english', ${query.search})`,
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(limit);
}

/**
 * Stores one fact for an agent or for the whole account, idempotently by
 * scope/agent/body so repeated model turns do not flood standing context.
 * Input: database, account id, and a fact with scope, optional agent id, body, and message id.
 * Output: the saved fact. A user fact is stored with a null agent id.
 */
export async function remember(db: Pick<Database, "insert" | "select">, accountId: string, input: unknown) {
  const fact = memoryFactSchema.parse(input);
  const scopeMatch =
    fact.scope === "user" ? isNull(memories.agentId) : eq(memories.agentId, fact.agentId ?? "");
  const [existing] = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.accountId, accountId),
        eq(memories.scope, fact.scope),
        eq(memories.body, fact.body),
        scopeMatch,
      ),
    )
    .limit(1);
  if (existing) return existing;
  const [row] = await db
    .insert(memories)
    .values({
      accountId,
      scope: fact.scope,
      agentId: fact.scope === "user" ? null : fact.agentId,
      body: fact.body,
      messageId: fact.messageId,
    })
    .returning();
  if (!row) {
    throw new Error("The memory insert returned no row.");
  }
  return row;
}

/**
 * Replaces one exact fact with a new fact that cites a new message.
 * Input: database, account id, and the scope, agent, old body, new body, and new message id.
 * Output: the saved fact. The row whose body matched the old text is gone.
 */
export async function correct(db: Database, accountId: string, input: unknown) {
  const fact = memoryCorrectSchema.parse(input);
  const scopeMatch =
    fact.scope === "user" ? isNull(memories.agentId) : eq(memories.agentId, fact.agentId ?? "");
  await db
    .delete(memories)
    .where(and(eq(memories.accountId, accountId), eq(memories.scope, fact.scope), eq(memories.body, fact.oldBody), scopeMatch));
  return remember(db, accountId, {
    scope: fact.scope,
    agentId: fact.agentId,
    body: fact.body,
    messageId: fact.messageId,
  });
}

/**
 * Lists the facts one agent is allowed to see.
 * Input: database, account id, and agent id.
 * Output: that agent's private facts plus the account's user facts. Another account's facts are absent.
 */
export async function memoriesFor(db: Database, accountId: string, agentId: string) {
  const rows = await db
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.accountId, accountId),
        sql`(${memories.scope} = 'user' or (${memories.scope} = 'agent' and ${memories.agentId} = ${agentId}))`,
      ),
    )
    .orderBy(desc(memories.createdAt))
    .limit(standingMemoryLimit);
  return rows.reverse();
}
