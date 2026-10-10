import { resolveSession, type Session } from "../desktop/desktop.js";
import { exec, execStdin } from "../linux/linux.js";

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
 * The shell script that makes sure a visible Chromium with DevTools is running.
 * Why: opening a page used to depend on the model typing a long launch
 * command exactly right. Weak models started a headless browser (the tools
 * answered, the screen stayed empty), launched without the DevTools port, or
 * tripped over a lock left by a crashed browser. This does it the same way
 * every time and says plainly what state the screen is in.
 * Input: display number and DevTools port. Output: script text; it prints one
 * line, `ready`, `started` or `failed: <why>`.
 */
export function ensureBrowserScript(display: number, cdpPort: number): string {
  const launch =
    `setsid nohup chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --start-maximized ` +
    `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort} about:blank >/tmp/chromium-${cdpPort}.log 2>&1 &`;
  return [
    `export DISPLAY=:${display}`,
    `version() { curl -s -m 2 http://127.0.0.1:${cdpPort}/json/version 2>/dev/null; }`,
    `alive() { ps -u "$(id -u)" -o stat=,args= 2>/dev/null | grep -v '^Z' | grep -q '[c]hromium'; }`,
    `window() { xdotool search --onlyvisible --class chromium 2>/dev/null | head -1; }`,
    // A window manager that died leaves windows unmanaged and the screen looking broken.
    `if ! pgrep -u "$(id -u)" -x jwm >/dev/null 2>&1 && [ -f /tmp/desktop-${display}/jwmrc ] && command -v jwm >/dev/null; then`,
    `  setsid nohup jwm -f /tmp/desktop-${display}/jwmrc >/tmp/jwm-${display}.log 2>&1 &`,
    `  sleep 0.5`,
    `fi`,
    `v="$(version)"`,
    // Headless answers the tools but shows the person nothing: replace it.
    `if echo "$v" | grep -qi headless; then pkill -u "$(id -u)" -f 'chromium.*--headless' 2>/dev/null; sleep 1; v=""; fi`,
    `if [ -n "$v" ] && [ -n "$(window)" ]; then echo ready; exit 0; fi`,
    `start() {`,
    `  if ! alive; then rm -f "$HOME/.config/chromium/SingletonLock" "$HOME/.config/chromium/SingletonSocket" "$HOME/.config/chromium/SingletonCookie" 2>/dev/null; fi`,
    `  ${launch}`,
    `  for i in $(seq 1 40); do [ -n "$(version)" ] && [ -n "$(window)" ] && return 0; sleep 0.5; done`,
    `  return 1`,
    `}`,
    `if start; then echo started; exit 0; fi`,
    // A browser already open without the DevTools port swallows the launch: close it and start clean.
    `pkill -u "$(id -u)" -f chromium 2>/dev/null; sleep 1; pkill -9 -u "$(id -u)" -f chromium 2>/dev/null; sleep 0.5`,
    `if start; then echo started; exit 0; fi`,
    `echo "failed: $(tail -c 300 /tmp/chromium-${cdpPort}.log 2>/dev/null | tr '\\n' ' ')"`,
    `exit 1`,
  ].join("\n");
}

/**
 * Makes sure this agent's visible browser is up before a browser tool uses it.
 * Input: account id and Linux user. Output: the desktop session it runs on, or throws with the reason.
 */
export async function ensureBrowser(accountId: string, profile: string): Promise<Session> {
  // Chromium needs the desktop up before it can open a window the person can see.
  const session = await resolveSession(accountId, profile);
  const result = await exec(accountId, ["bash", "-lc", ensureBrowserScript(session.display, session.cdpPort)], profile);
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  if (result.code === 0 && (line === "ready" || line === "started")) return session;
  throw new Error(`The browser did not start on the desktop. ${line.replace(/^failed:\s*/, "").slice(0, 300)}`.trim());
}

/**
 * Opens one page in the visible browser and confirms it is on screen.
 * Why: "open X and hand it to me" should be one dependable call, not a
 * multi-step job a model can get wrong.
 * Input: account id, Linux user, http(s) URL. Output: one plain line about what is showing.
 */
export async function openOnScreen(accountId: string, profile: string, rawUrl: string): Promise<string> {
  const text = rawUrl.trim();
  const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http or https pages can be opened.");
  const reply = await runBrowserTool(accountId, profile, "browser_navigate", { url: url.toString() });
  const session = await resolveSession(accountId, profile);
  const shown = await exec(
    accountId,
    [
      "bash",
      "-lc",
      // The title follows the page a moment after navigation; wait briefly for it to settle.
      `export DISPLAY=:${session.display}; for i in 1 2 3 4 5 6; do id="$(xdotool search --onlyvisible --class chromium 2>/dev/null | head -1)"; name="$([ -n "$id" ] && xdotool getwindowname "$id" 2>/dev/null)"; case "$name" in ""|about:blank*|"New Tab"*) sleep 0.5;; *) break;; esac; done; [ -n "$id" ] && echo "$name"`,
    ],
    profile,
  );
  const title = shown.stdout.trim().split("\n")[0]?.slice(0, 120) ?? "";
  if (shown.code !== 0 || !title) {
    return `The page was requested (${url.toString()}) but no browser window is visible on the desktop, so the person cannot see it. Browser said: ${reply.slice(0, 300)}`;
  }
  return `Opened ${url.toString()} in the browser on your desktop. The window is on screen, titled "${title}". The person can watch it and take over.`;
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
  // The visible browser is started here when it is not running, so no tool
  // call depends on the model launching Chromium correctly first.
  const { cdpPort } = await ensureBrowser(accountId, profile);
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
    return `The browser is running but did not answer. Try the call once more; if it fails again, report it under Blockers.`;
  }
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[truncated]` : text;
}
