import type { getDb } from "../db/client.js";
import { execStdin } from "../linux/linux.js";
import { googleAccessToken } from "../mcp/google-oauth.js";
import { googleRefreshToken } from "../mcp/plugins.js";

const MAX_OUTPUT = 20_000;
type Database = ReturnType<typeof getDb>;

/**
 * Runs one featured Google tool inside the account container.
 * Why: the access token is minted on the core, then the container calls Google. The login session is not used.
 */
export async function runGoogleTool(
  db: Database,
  accountId: string,
  slug: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const stored = await googleRefreshToken(db, accountId);
  if (!stored?.refreshToken) return "Connect this Google plugin again.";
  const access = await googleAccessToken(stored.refreshToken);
  await execStdin(
    accountId,
    ["sh", "-c", "mkdir -p /var/nano/mcp/secrets && cat > /var/nano/mcp/secrets/google && chmod 600 /var/nano/mcp/secrets/google"],
    Buffer.from(access),
  );
  const result = await execStdin(
    accountId,
    ["node", "/opt/nano/google-bridge.mjs"],
    Buffer.from(JSON.stringify({ slug, tool: toolName, args })),
  );
  const text = result.stdout.toString("utf8").trim();
  if (result.code !== 0 && !text) return "Google bridge failed inside this account's computer.";
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[truncated]` : text;
}
