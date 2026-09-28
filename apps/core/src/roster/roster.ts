import { accountSchema, agentCreateSchema, agentProfileSchema } from "@nano-agents/shared";
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { accounts, agents } from "../db/schema.js";
import { createLinux } from "../linux/linux.js";

type Database = ReturnType<typeof getDb>;

/**
 * Creates an account row and that account's Linux.
 * Input: a database client and an object with a name.
 * Output: the saved account, including its id. A container exists for that id.
 */
export async function createAccount(db: Database, input: unknown) {
  const data = accountSchema.parse(input);
  const [row] = await db.insert(accounts).values({ name: data.name }).returning();
  if (!row) {
    throw new Error("The account insert returned no row.");
  }
  await createLinux(row.id);
  return row;
}

/**
 * Hires an agent inside one account.
 * Input: a database client, the account id, and the agent's name, label, description, provider, and model id.
 * Output: the saved agent. linuxProfile is null because the chat creates the profile later.
 */
export async function createAgent(db: Database, accountId: string, input: unknown) {
  const data = agentCreateSchema.parse(input);
  const [row] = await db
    .insert(agents)
    .values({
      accountId,
      name: data.name,
      label: data.label,
      description: data.description,
      provider: data.provider,
      modelId: data.modelId,
      linuxProfile: null,
    })
    .returning();
  if (!row) {
    throw new Error("The agent insert returned no row.");
  }
  return row;
}

/**
 * Changes an agent's name, label, description, pin, hide, and notify.
 * Input: a database client, the owning account id, the agent id, and the profile fields.
 * Output: the updated agent, or null when that account does not own the agent.
 */
export async function updateAgentFlags(db: Database, accountId: string, agentId: string, input: unknown) {
  const data = agentProfileSchema.parse(input);
  const [row] = await db
    .update(agents)
    .set({
      notify: data.notify,
      pinned: data.pinned,
      hidden: data.hidden,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.label !== undefined ? { label: data.label } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
    })
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)))
    .returning();
  return row ?? null;
}

/**
 * Lists the agents on one account.
 * Input: a database client and the account id.
 * Output: that account's agents. Another account's agents are not included.
 */
export async function listAgents(db: Database, accountId: string) {
  return db.select().from(agents).where(eq(agents.accountId, accountId));
}

/**
 * Reads one agent that belongs to an account.
 * Input: a database client, the account id, and the agent id.
 * Output: the agent row, or null when the account does not own it.
 */
export async function getAgent(db: Database, accountId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)))
    .limit(1);
  return row ?? null;
}
