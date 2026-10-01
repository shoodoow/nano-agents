/**
 * MCP client sessions pooled per account server row (HTTP only for tenant config).
 */
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpToolCacheEntry } from "./types.js";
import { formatMcpToolResult } from "./result.js";

export type McpLiveSession = {
  client: Client;
  close: () => Promise<void>;
};

const pool = new Map<string, McpLiveSession>();

function poolKey(accountId: string, serverId: string): string {
  return `${accountId}:${serverId}`;
}

export async function connectHttpMcp(url: string, bearerToken: string): Promise<McpLiveSession> {
  const headers: Record<string, string> = {};
  if (bearerToken.trim()) {
    headers.Authorization = bearerToken.startsWith("Bearer ") ? bearerToken : `Bearer ${bearerToken}`;
  }
  const client = new Client({ name: "nano-agents", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: headers.Authorization ? { headers } : undefined,
  });
  await client.connect(transport);
  return {
    client,
    close: () => transport.close(),
  };
}

export async function getMcpSession(accountId: string, serverId: string, url: string, bearerToken: string): Promise<McpLiveSession> {
  const key = poolKey(accountId, serverId);
  const existing = pool.get(key);
  if (existing) return existing;
  const session = await connectHttpMcp(url, bearerToken);
  pool.set(key, session);
  return session;
}

export async function closeMcpSession(accountId: string, serverId: string): Promise<void> {
  const key = poolKey(accountId, serverId);
  const session = pool.get(key);
  if (!session) return;
  pool.delete(key);
  await session.close();
}

export async function closeAllMcpSessions(): Promise<void> {
  await Promise.allSettled([...pool.values()].map((row) => row.close()));
  pool.clear();
}

export async function listMcpTools(session: McpLiveSession): Promise<McpToolCacheEntry[]> {
  const list = await session.client.listTools();
  return list.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
  }));
}

export async function callMcpTool(session: McpLiveSession, toolName: string, input: Record<string, unknown>): Promise<unknown> {
  const result = await session.client.callTool({ name: toolName, arguments: input });
  return formatMcpToolResult(result);
}
