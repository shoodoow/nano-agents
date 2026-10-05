/**
 * Per-account MCP server records (URL + sealed bearer). Stdio stays out of tenant config.
 */
import { mcpServerInputSchema } from "@nano-agents/shared";
import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import { seal } from "../keys/keys.js";
import { listMcpToolsInCage, syncMcpConfig } from "../computer/mcp-bridge.js";
import { createLinux, exec } from "../linux/linux.js";
import { catalogPlugin } from "./catalog.js";
import { readSecret, sealOAuth, type OAuthSecret } from "./credential.js";
import { refreshOAuthSecret, updateOAuthSecret } from "./mcp-oauth.js";
import { dropGoogleTokenIfUnused } from "./plugins.js";
import { closeMcpSession } from "./session.js";
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
  await closeMcpSession(accountId, row.id);
  await db.delete(mcpServers).where(and(eq(mcpServers.accountId, accountId), eq(mcpServers.slug, slug)));
  if (row.kind === "google" && (await dropGoogleTokenIfUnused(db, accountId))) {
    await exec(accountId, ["rm", "-f", "/var/nano/mcp/secrets/google"]).catch(() => {});
  }
  const remaining = await db.select().from(mcpServers).where(eq(mcpServers.accountId, accountId));
  await syncRemoteSecrets(db, accountId, remaining).catch(() => {});
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
    ? { secret: seal(data.secret.trim()), cageBearer: data.secret.trim() }
    : existing?.secret
      ? { secret: existing.secret, cageBearer: await bearerForRow(db, existing) }
      : { secret: seal(""), cageBearer: "" };

  let toolsCache: McpToolCacheEntry[] = existing ? parseToolsCache(existing.toolsCache) : [];
  let lastError: string | null = null;
  if (existing) await closeMcpSession(accountId, existing.id);
  try {
    const others = await db.select().from(mcpServers).where(eq(mcpServers.accountId, accountId));
    await syncRemoteSecrets(db, accountId, others.filter((row) => row.slug !== data.slug), {
      slug: data.slug,
      url: data.url,
      secret: typed.cageBearer,
    });
    const listed = await listMcpToolsInCage(accountId, data.slug);
    if ("error" in listed) {
      lastError = listed.error;
      toolsCache = [];
    } else {
      toolsCache = listed;
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Could not reach the MCP bridge in this account's computer.";
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
 * Stores an OAuth refresh bundle for one custom MCP and publishes only the access token into that account's container.
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
  if (existing) await closeMcpSession(accountId, existing.id);
  let toolsCache: McpToolCacheEntry[] = [];
  let lastError: string | null = null;
  try {
    const others = await db.select().from(mcpServers).where(eq(mcpServers.accountId, accountId));
    await syncRemoteSecrets(db, accountId, others.filter((row) => row.slug !== input.slug), {
      slug: input.slug,
      url: input.url,
      secret: input.oauth.accessToken,
    });
    const listed = await listMcpToolsInCage(accountId, input.slug);
    if ("error" in listed) {
      lastError = listed.error;
    } else {
      toolsCache = listed;
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : "Could not reach the MCP bridge in this account's computer.";
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

/**
 * Returns the bearer the container should send. Refreshes an expired MCP access token on the core first.
 */
export async function bearerForMcpRow(db: Database, row: typeof mcpServers.$inferSelect): Promise<string> {
  return bearerForRow(db, row);
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

async function syncRemoteSecrets(
  db: Database,
  accountId: string,
  rows: (typeof mcpServers.$inferSelect)[],
  extra?: { slug: string; url: string; secret: string },
): Promise<void> {
  const remote = [];
  for (const row of rows) {
    if (row.kind === "google") continue;
    remote.push({ slug: row.slug, url: row.url, secret: await bearerForRow(db, row) });
  }
  if (extra) remote.push(extra);
  await createLinux(accountId);
  await syncMcpConfig(accountId, remote);
}
