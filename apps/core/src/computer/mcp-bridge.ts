import { exec, execStdin } from "../linux/linux.js";

const SLUG = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_OUTPUT = 20_000;

export type CageMcpServer = { slug: string; url: string; secret: string };

/**
 * Writes this account's MCP config into its container volume.
 * Why: the HTTP client runs in the cage, so secrets never stay only on the host process.
 * Input: account id and the servers to publish. Output: nothing.
 */
export async function syncMcpConfig(accountId: string, servers: CageMcpServer[]): Promise<void> {
  const publicConfig = servers.map((server) => ({ slug: server.slug, url: server.url }));
  await exec(accountId, ["mkdir", "-p", "/var/nano/mcp/secrets"]);
  await execStdin(
    accountId,
    ["sh", "-c", "cat > /var/nano/mcp/servers.json"],
    Buffer.from(JSON.stringify(publicConfig)),
  );
  for (const server of servers) {
    if (!SLUG.test(server.slug)) throw new Error("MCP slug is not safe to store.");
    await execStdin(
      accountId,
      ["sh", "-c", `cat > /var/nano/mcp/secrets/${server.slug} && chmod 600 /var/nano/mcp/secrets/${server.slug}`],
      Buffer.from(server.secret),
    );
  }
}

/**
 * Calls one MCP tool from inside the account container.
 * Input: account id, server slug, tool name, arguments. Output: bridge text.
 */
export async function runMcpTool(
  accountId: string,
  slug: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!SLUG.test(slug)) throw new Error("MCP slug is invalid.");
  const result = await execStdin(
    accountId,
    ["node", "/opt/nano/mcp-bridge.mjs"],
    Buffer.from(JSON.stringify({ op: "call", slug, tool: toolName, arguments: args })),
  );
  const text = result.stdout.toString("utf8").trim();
  if (result.code !== 0 && !text) return "MCP bridge failed inside this account's computer.";
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[truncated]` : text;
}

/**
 * Lists tools for one server using the in-container bridge.
 * Input: account id and slug. Output: parsed tool entries, or an error string.
 */
export async function listMcpToolsInCage(
  accountId: string,
  slug: string,
): Promise<{ name: string; description: string; inputSchema?: unknown }[] | { error: string }> {
  if (!SLUG.test(slug)) return { error: "MCP slug is invalid." };
  const result = await execStdin(
    accountId,
    ["node", "/opt/nano/mcp-bridge.mjs"],
    Buffer.from(JSON.stringify({ op: "list", slug })),
  );
  const text = result.stdout.toString("utf8").trim();
  if (result.code !== 0) return { error: text || "MCP list failed inside this account's computer." };
  try {
    const parsed = JSON.parse(text) as { tools?: { name: string; description?: string; inputSchema?: unknown }[] };
    return (parsed.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }));
  } catch {
    return { error: text || "MCP list returned invalid JSON." };
  }
}
