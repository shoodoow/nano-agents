import { createPublicFetch } from "../net/public-fetch.js";
import type { McpToolCacheEntry } from "./types.js";
import { assertSafeMcpUrl } from "./url.js";

type FetchImpl = typeof fetch;
type Rpc = { session: string | undefined; parsed: Record<string, unknown> };

/** A tool call may wait on a slow remote service, so it gets longer than a page fetch. */
const mcpFetch = createPublicFetch({ timeoutMs: 120_000, maxBodyBytes: 5_000_000 });

/**
 * Lists the tools one MCP server offers.
 * Why here and not in the account's container: the bearer token then never
 * leaves the core, so an agent cannot read it and send it elsewhere. The
 * request can only reach a public address.
 * Input: the server URL and its bearer token (empty for an open server).
 * Output: the server's tools. Throws when the server cannot be reached or refuses.
 */
export async function listMcpTools(url: string, bearer: string, fetchImpl: FetchImpl = mcpFetch): Promise<McpToolCacheEntry[]> {
  const session = await openSession(url, bearer, fetchImpl);
  const listed = await rpc(fetchImpl, url, bearer, session, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = (listed.parsed.result as { tools?: { name: string; description?: string; inputSchema?: unknown }[] } | undefined)?.tools ?? [];
  return tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }));
}

/**
 * Calls one tool on an MCP server.
 * Input: the server URL, its bearer token, the tool name and its arguments.
 * Output: the server's result object. Throws when the server cannot be reached or refuses.
 */
export async function callMcpTool(
  url: string,
  bearer: string,
  toolName: string,
  args: Record<string, unknown>,
  fetchImpl: FetchImpl = mcpFetch,
): Promise<unknown> {
  const session = await openSession(url, bearer, fetchImpl);
  const called = await rpc(fetchImpl, url, bearer, session, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
  return called.parsed.result ?? called.parsed;
}

function headers(bearer: string, session: string | undefined): Record<string, string> {
  const out: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (bearer) out.authorization = bearer.startsWith("Bearer ") ? bearer : `Bearer ${bearer}`;
  if (session) out["mcp-session-id"] = session;
  return out;
}

/** Sends one JSON-RPC message. The answer is plain JSON or the first event of an event stream. */
async function rpc(fetchImpl: FetchImpl, url: string, bearer: string, session: string | undefined, body: unknown): Promise<Rpc> {
  assertSafeMcpUrl(url);
  const response = await fetchImpl(url, { method: "POST", headers: headers(bearer, session), body: JSON.stringify(body) });
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(dataLine ? dataLine.slice(5).trim() : text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const message = (parsed.error as { message?: string } | undefined)?.message;
    throw new Error(message || text.slice(0, 500) || `MCP HTTP ${response.status}`);
  }
  return { session: response.headers.get("mcp-session-id") || session, parsed };
}

async function openSession(url: string, bearer: string, fetchImpl: FetchImpl): Promise<string | undefined> {
  const init = await rpc(fetchImpl, url, bearer, undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "nano-agents", version: "0" },
    },
  });
  // The server does not answer this notice, and some servers reject it; the session works either way.
  await fetchImpl(url, {
    method: "POST",
    headers: headers(bearer, init.session),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => undefined);
  return init.session;
}
