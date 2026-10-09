import { cdpPortFor, resolveSession } from "../desktop/desktop.js";
import { execStdin } from "../linux/linux.js";

/** Tools the in-container bridge accepts. Names match the agent tool list. */
export const BROWSER_BRIDGE_TOOLS = [
  "browser_list_pages",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_press_key",
  "browser_handle_dialog",
  "browser_wait_for",
] as const;

export type BrowserBridgeTool = (typeof BROWSER_BRIDGE_TOOLS)[number];

const MAX_OUTPUT = 20_000;

/**
 * Checks a browser tool call before it enters the account container.
 * Why: the model must not pass a container name, a host, or a non-http URL.
 * Input: tool name and args. Output: the JSON body the bridge reads on stdin.
 */
export function browserBridgeRequest(name: string, args: Record<string, unknown>): string {
  if (!BROWSER_BRIDGE_TOOLS.includes(name as BrowserBridgeTool)) {
    throw new Error(`Unknown browser tool ${name}.`);
  }
  if (name === "browser_navigate") {
    const url = new URL(String(args.url ?? ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("browser_navigate only opens http or https URLs.");
    }
  }
  return JSON.stringify({ tool: name, args });
}

/**
 * Runs one browser tool inside the account container over stdin/stdout.
 * Why: CDP stays on 127.0.0.1 in that cage. Core never dials the container IP.
 * Input: account id, Linux user, tool name, args. Output: bridge text, capped.
 */
export async function runBrowserTool(
  accountId: string,
  profile: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  // Chromium needs the desktop up before it can open a window the person can see.
  await resolveSession(accountId, profile);
  const cdpPort = cdpPortFor(profile);
  const body = JSON.stringify({
    ...JSON.parse(browserBridgeRequest(name, args)),
    cdpPort,
  });
  const result = await execStdin(
    accountId,
    ["node", "/opt/nano/browser-bridge.mjs"],
    Buffer.from(body),
    profile,
    [`NANO_CDP_PORT=${cdpPort}`],
  );
  const text = result.stdout.toString("utf8").trim();
  if (result.code !== 0 && !text) {
    return `Browser bridge failed. Start Chromium on your desktop with remote debugging on 127.0.0.1:${cdpPort}.`;
  }
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[truncated]` : text;
}
