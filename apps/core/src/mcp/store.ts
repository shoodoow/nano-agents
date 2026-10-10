/**
 * Per-account MCP server records (URL + sealed bearer). Stdio stays out of tenant config.
 */
import { mcpServerInputSchema } from "@nano-agents/shared";
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import { seal } from "../keys/keys.js";
import { catalogPlugin } from "./catalog.js";
import { callMcpTool, listMcpTools } from "./client.js";
import { readSecret, sealOAuth, type OAuthSecret } from "./credential.js";
import { refreshOAuthSecret, updateOAuthSecret } from "./mcp-oauth.js";
import { dropGoogleTokenIfUnused } from "./plugins.js";
import type { McpToolCacheEntry } from "./types.js";
import { assertSafeMcpUrl } from "./url.js";

type Database = ReturnType<typeof getDb>;

export type StoredMcpServer = {
  id: string;
  slug: string;
  url: string;
  kind: string;
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
    kind: row.kind,
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
    .select({ id: mcpServers.id, kind: mcpServers.kind })
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, slug)));
  if (!row) return;
  await db.delete(mcpServers).where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, slug)));
  if (row.kind === "google") await dropGoogleTokenIfUnused(db, accountId);
}

export async function saveMcpServer(db: Database, accountId: string, input: unknown): Promise<StoredMcpServer> {
  const data = mcpServerInputSchema.parse(input);
  if (catalogPlugin(data.slug)) throw new Error("That name is reserved for a featured plugin.");
  assertSafeMcpUrl(data.url);
  const [existing] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, data.slug)));
  const typed = data.secret.trim()
    ? { secret: seal(data.secret.trim()), bearer: data.secret.trim() }
    : existing?.secret
      ? { secret: existing.secret, bearer: await bearerForRow(db, existing) }
      : { secret: seal(""), bearer: "" };

  let toolsCache: McpToolCacheEntry[] = existing ? parseToolsCache(existing.toolsCache) : [];
  let lastError: string | null = null;
  try {
    toolsCache = await listMcpTools(data.url, typed.bearer);
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Could not reach the MCP server.";
    toolsCache = [];
  }

  const enabled = data.enabled ?? existing?.enabled ?? true;
  const values = {
    accountId,
    slug: data.slug,
    url: data.url,
    secret: typed.secret,
    kind: "remote",
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

/**
 * Stores an OAuth refresh bundle for one custom MCP and reads the server's tool list.
 */
export async function saveOAuthMcpServer(
  db: Database,
  accountId: string,
  input: { slug: string; url: string; oauth: OAuthSecret },
): Promise<StoredMcpServer> {
  const sealed = sealOAuth(input.oauth);
  const [existing] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, input.slug)));
  let toolsCache: McpToolCacheEntry[] = [];
  let lastError: string | null = null;
  try {
    toolsCache = await listMcpTools(input.url, input.oauth.accessToken);
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Could not reach the MCP server.";
  }
  const values = {
    accountId,
    slug: input.slug,
    url: input.url,
    secret: sealed,
    kind: "remote",
    enabled: true,
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

const MAX_TOOL_OUTPUT = 20_000;

/**
 * Calls one tool on an account's custom MCP server.
 * Why the row is read again here: a long turn can outlive an access token.
 * Reading the stored secret at call time uses the newest token, and a refresh
 * made by an earlier call is not repeated with a refresh token already spent.
 * Input: database, account id, server slug, tool name and arguments.
 * Output: the result as JSON text, or a plain sentence when the call failed.
 */
export async function runMcpTool(
  db: Database,
  accountId: string,
  slug: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const [row] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, slug), eq(mcpServers.enabled, true)));
  if (!row || row.kind === "google") return `No MCP server named ${slug} is connected.`;
  try {
    const result = await callMcpTool(row.url, await bearerForRow(db, row), toolName, args);
    const text = JSON.stringify(result);
    return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n[truncated]` : text;
  } catch (error) {
    return error instanceof Error ? error.message : "The MCP server did not answer.";
  }
}

async function bearerForRow(
  db: Database,
  row: { id: string; secret: string; kind: string },
): Promise<string> {
  if (row.kind === "google") return "";
  const opened = readSecret(row.secret);
  if (!opened.oauth) return opened.bearer;
  if (opened.bearer) return opened.bearer;
  if (!opened.oauth.refreshToken || !row.id) return opened.oauth.accessToken;
  const next = await refreshOAuthSecret(opened.oauth);
  await updateOAuthSecret(db, row.id, next);
  return next.accessToken;
}
