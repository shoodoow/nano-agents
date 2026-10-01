/**
 * Account-scoped MCP tools for prompts and the AI SDK tool map.
 */
import { jsonSchema, tool } from "ai";
import type { getDb } from "../db/client.js";
import type { ToolContext } from "../turn/tools/context.js";
import { bearerForMcpRow, mcpRowsForAccount } from "./store.js";
import { callMcpTool, getMcpSession } from "./session.js";
import type { McpToolCacheEntry } from "./types.js";

type Db = ReturnType<typeof getDb>;

export function mcpToolOffersFromRows(
  rows: { slug: string; toolsCache: unknown }[],
): { server: string; tools: { name: string; description: string }[] }[] {
  return rows
    .map((row) => {
      const tools = (Array.isArray(row.toolsCache) ? row.toolsCache : []) as McpToolCacheEntry[];
      return {
        server: row.slug,
        tools: tools.map((t) => ({ name: t.name, description: t.description || `MCP ${row.slug}/${t.name}` })),
      };
    })
    .filter((entry) => entry.tools.length > 0)
    .sort((a, b) => a.server.localeCompare(b.server));
}

export async function mcpToolOffers(db: Db, accountId: string) {
  const rows = await mcpRowsForAccount(db, accountId);
  return mcpToolOffersFromRows(rows);
}

function mcpInputSchema(entry: McpToolCacheEntry) {
  if (entry.inputSchema && typeof entry.inputSchema === "object") {
    return jsonSchema(entry.inputSchema as Record<string, unknown>);
  }
  return jsonSchema({ type: "object", properties: {} });
}

type ToolExecuteWrap = (
  name: string,
  execute: (input: Record<string, unknown>) => Promise<unknown>,
) => (input: Record<string, unknown>) => Promise<unknown>;

/** Adds this account's MCP tools into an existing tool map (names `{slug}_{tool}`). */
export async function appendMcpTools(
  ctx: ToolContext,
  set: Record<string, unknown>,
  wrapExecute: ToolExecuteWrap,
): Promise<void> {
  const rows = await mcpRowsForAccount(ctx.db, ctx.accountId);
  for (const row of rows) {
    const tools = (Array.isArray(row.toolsCache) ? row.toolsCache : []) as McpToolCacheEntry[];
    if (tools.length === 0) continue;
    const token = await bearerForMcpRow(row);
    for (const entry of tools) {
      const fullName = `${row.slug}_${entry.name}`;
      set[fullName] = tool({
        description: entry.description || `MCP ${row.slug}/${entry.name}`,
        inputSchema: mcpInputSchema(entry) as never,
        execute: wrapExecute(fullName, async (input) => {
          const session = await getMcpSession(ctx.accountId, row.id, row.url, token);
          return callMcpTool(session, entry.name, input);
        }) as never,
      });
    }
  }
}
