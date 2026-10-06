import { accountSchema, agentCreateSchema, agentProfileSchema, randomSurpriseMark } from "@nano-agents/shared";
import { and, eq, sql } from "drizzle-orm";
import type { getDb, Store } from "../db/client.js";
import { accounts, agents } from "../db/schema.js";
import { createLinux } from "../linux/linux.js";
import { resolveGatewayContextWindow } from "../model/gateway-models.js";

type Database = ReturnType<typeof getDb>;

export class AgentNameError extends Error {
  constructor() {
    super("An agent with this name already exists on this account");
    this.name = "AgentNameError";
  }
}

/**
 * Creates an account row and that account's Linux.
 * Why: the account is the tenant — one Linux per account, every later row
 * carries this id so nothing crosses accounts.
 * Input: a database client and an object with a name.
 * Output: the saved account, including its id. A container exists for that id.
 */
export async function createAccount(db: Database, input: unknown, options?: { email?: string }) {
  const data = accountSchema.parse(input);
  const [row] = await db.insert(accounts).values({ name: data.name }).returning();
  if (!row) {
    throw new Error("The account insert returned no row.");
  }
  try {
    await createLinux(row.id, options?.email);
  } catch (error) {
    await db.delete(accounts).where(eq(accounts.id, row.id));
    throw error;
  }
  return row;
}

/**
 * Hires an agent inside one account.
 * Why: names are unique per account (case-insensitive) because @Name routing
 * and the room header resolve by exact name — duplicates silently steal each
 * other's mentions. Same name on another account is fine.
 * Input: a database client, the account id, and name/label/role/personality/
 * jobDescription/provider/modelId.
 * Output: the saved agent. linuxProfile is null because the chat creates the profile later.
 */
export async function createAgent(db: Database, accountId: string, input: unknown) {
  const data = agentCreateSchema.parse(input);
  const siblings = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.accountId, accountId));
  if (siblings.some((sibling) => sibling.name.toLowerCase() === data.name.toLowerCase())) {
    throw new AgentNameError();
  }
  const surprise = randomSurpriseMark();
  const modelContextWindow = await resolveGatewayContextWindow(data.provider, data.modelId);
  const [row] = await db
    .insert(agents)
    .values({
      accountId,
      name: data.name,
      label: data.label,
      role: data.role,
      personality: data.personality ?? "",
      jobDescription: data.jobDescription,
      provider: data.provider,
      modelId: data.modelId,
      modelContextWindow,
      linuxProfile: null,
      markShape: surprise.markShape,
      markColor: surprise.markColor,
      markMaterial: surprise.markMaterial,
      markStyle: surprise.markStyle,
      markGender: surprise.markGender,
    })
    .returning();
  if (!row) {
    throw new Error("The agent insert returned no row.");
  }
  return row;
}

/**
 * Changes an agent's name, label, identity, model provider, pin, hide, and notify.
 * Why: identity edits bump promptVersion so the OpenAI promptCacheKey rotates
 * — otherwise the provider keeps serving the stale cached prefix.
 * Input: a database client, the owning account id, the agent id, and profile fields.
 * Output: the updated agent, or null when that account does not own the agent.
 */
export async function updateAgentFlags(db: Store, accountId: string, agentId: string, input: unknown) {
  const data = agentProfileSchema.parse(input);
  const identityTouched =
    data.name !== undefined ||
    data.label !== undefined ||
    data.role !== undefined ||
    data.personality !== undefined ||
    data.jobDescription !== undefined;
  let modelContextWindow: number | null | undefined;
  if (data.provider !== undefined || data.modelId !== undefined) {
    const current = await getAgent(db, accountId, agentId);
    if (current) {
      modelContextWindow = await resolveGatewayContextWindow(
        data.provider ?? current.provider,
        data.modelId ?? current.modelId,
      );
    }
  }
  const [row] = await db
    .update(agents)
    .set({
      ...(data.notify !== undefined ? { notify: data.notify } : {}),
      ...(data.pinned !== undefined ? { pinned: data.pinned } : {}),
      ...(data.hidden !== undefined ? { hidden: data.hidden } : {}),
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.label !== undefined ? { label: data.label } : {}),
      ...(data.role !== undefined ? { role: data.role } : {}),
      ...(data.personality !== undefined ? { personality: data.personality } : {}),
      ...(data.jobDescription !== undefined ? { jobDescription: data.jobDescription } : {}),
      ...(data.provider !== undefined ? { provider: data.provider } : {}),
      ...(data.modelId !== undefined ? { modelId: data.modelId } : {}),
      ...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
      ...(data.markShape !== undefined ? { markShape: data.markShape } : {}),
      ...(data.markColor !== undefined ? { markColor: data.markColor } : {}),
      ...(data.markMaterial !== undefined ? { markMaterial: data.markMaterial } : {}),
      ...(data.markStyle !== undefined ? { markStyle: data.markStyle } : {}),
      ...(data.markGender !== undefined ? { markGender: data.markGender } : {}),
      ...(data.avatarUrl !== undefined ? { avatarUrl: data.avatarUrl } : {}),
      ...(identityTouched ? { promptVersion: sql`${agents.promptVersion} + 1` } : {}),
    })
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)))
    .returning();
  return row ?? null;
}

/**
 * Lists the agents on one account.
 * Why: roster and team pickers scope to the tenant — cross-account rows never leave the query.
 * Input: a database client and the account id.
 * Output: that account's agents. Another account's agents are not included.
 */
export async function listAgents(db: Database, accountId: string) {
  return db.select().from(agents).where(eq(agents.accountId, accountId));
}

/**
 * Reads one agent that belongs to an account.
 * Why: per-request ownership re-check — ids are never trusted from the client.
 * Input: a database client, the account id, and the agent id.
 * Output: the agent row, or null when the account does not own it.
 */
export async function getAgent(db: Store, accountId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.accountId, accountId)))
    .limit(1);
  return row ?? null;
}
