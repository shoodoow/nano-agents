/**
 * Per-account MCP server records (URL + sealed bearer). Stdio stays out of tenant config.
 */
import { mcpServerInputSchema } from "@nano-agents/shared";
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import { open, seal } from "../keys/keys.js";
import { closeMcpSession, connectHttpMcp, listMcpTools } from "./session.js";
import type { McpToolCacheEntry } from "./types.js";
import { assertSafeMcpUrl } from "./url.js";

type Database = ReturnType<typeof getDb>;

export type StoredMcpServer = {
  id: string;
  slug: string;
  url: string;
  enabled: boolean;
  configured: boolean;
  tools: McpToolCacheEntry[];
  lastError: string | null;
};

function parseToolsCache(raw: unknown): McpToolCacheEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is McpToolCacheEntry => typeof row === "object" && row !== null && typeof (row as McpToolCacheEntry).name === "string");
}

function toStored(row: typeof mcpServers.$inferSelect): StoredMcpServer {
  const tools = parseToolsCache(row.toolsCache);
  return {
    id: row.id,
    slug: row.slug,
    url: row.url,
    enabled: row.enabled,
    configured: tools.length > 0 && !row.lastError,
    tools,
    lastError: row.lastError,
  };
}

export async function listMcpServers(db: Database, accountId: string): Promise<StoredMcpServer[]> {
  const rows = await db.select().from(mcpServers).where(eq(mcpServers.accountId, accountId));
  return rows.map(toStored).sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function deleteMcpServer(db: Database, accountId: string, slug: string): Promise<void> {
  const [row] = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, slug)));
  if (!row) return;
  await closeMcpSession(accountId, row.id);
  await db.delete(mcpServers).where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, slug)));
}

export async function saveMcpServer(db: Database, accountId: string, input: unknown): Promise<StoredMcpServer> {
  const data = mcpServerInputSchema.parse(input);
  assertSafeMcpUrl(data.url);
  const [existing] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, data.slug)));
  const plain = data.secret.trim() || (existing ? open(existing.secret) : "");
  const secret = seal(plain);

  let toolsCache: McpToolCacheEntry[] = existing ? parseToolsCache(existing.toolsCache) : [];
  let lastError: string | null = null;
  try {
    const session = await connectHttpMcp(data.url, plain);
    toolsCache = await listMcpTools(session);
    await session.close();
    if (existing) await closeMcpSession(accountId, existing.id);
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Could not connect to MCP server.";
    toolsCache = [];
  }

  const enabled = data.enabled ?? existing?.enabled ?? true;
  const values = {
    accountId,
    slug: data.slug,
    url: data.url,
    secret,
    enabled,
    toolsCache,
    lastError,
  };

  if (existing) {
    await db.update(mcpServers).set(values).where(eq(mcpServers.id, existing.id));
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, existing.id));
    return toStored(row!);
  }
  const [row] = await db.insert(mcpServers).values(values).returning();
  return toStored(row!);
}

export async function mcpRowsForAccount(db: Database, accountId: string): Promise<(typeof mcpServers.$inferSelect)[]> {
  return db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.enabled, true)));
}

export async function bearerForMcpRow(row: typeof mcpServers.$inferSelect): Promise<string> {
  return open(row.secret);
}
