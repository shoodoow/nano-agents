import type { getDb } from "../db/client.js";
import { toolKeyFor } from "../keys/tools.js";
import { bash, clickAt, moveMouse, pressKeys, readFile, screenshotImage, typeText, writeFile } from "./computer.js";
import { globFiles, grepFiles } from "./find.js";
import { webSearch } from "./search.js";
import { webFetch } from "./web.js";
import { runBrowserTool } from "./browser-bridge.js";

type Database = ReturnType<typeof getDb>;

/** Parent web_fetch budget: enough for a snippet, not a research dump. */
export const DISPATCHER_FETCH_CHARS = 10_000;
const WORKER_OUTPUT_CHARS = 8_000;

export type LinuxToolExecute = (input: Record<string, unknown>) => Promise<unknown>;

/**
 * Execute bodies for Linux worker tools (schemas live in @nano-agents/agent-tools).
 * Why: one factory per worker run, so per-run budgets (screenshot cap) reset
 * with the run. Screenshots compound in model context — each one re-bills
 * every later step — so the camera stops after the budget and the worker
 * continues with DOM/text methods instead of burning millions of tokens.
 * Parent cheap tools pass fetchChars so a dispatcher fetch cannot dump a novel.
 */
export function linuxToolExecutes(
  db: Database,
  accountId: string,
  profile: string,
  opts?: { fetchChars?: number },
): Record<string, LinuxToolExecute> {
  /** Screenshots this worker has taken. Reset per run by construction. */
  let screenshots = 0;
  const SCREENSHOT_BUDGET = 4;
  return {
    read: async (input) => conciseOutput(await readFile(accountId, profile, String(input.path))),
    write: async (input) => {
      await writeFile(accountId, profile, String(input.path), String(input.body));
      return "Wrote the file.";
    },
    bash: async (input) => conciseOutput(await bash(accountId, profile, String(input.command))),
    computer_screenshot: async () => {
      screenshots += 1;
      if (screenshots > SCREENSHOT_BUDGET) {
        return (
          `Screenshot budget spent (${SCREENSHOT_BUDGET} this run). Do not shoot again — ` +
          `continue with web_fetch, headless --dump-dom, and the coordinates/descriptions you already have. ` +
          `Only pixels you have not yet seen justify another look, and the camera stays off.`
        );
      }
      return screenshotImage(accountId, profile);
    },
    computer_mouse: async (input) => moveMouse(accountId, profile, Number(input.x), Number(input.y)),
    computer_click: async (input) => clickAt(accountId, profile, Number(input.x), Number(input.y)),
    computer_type: async (input) => typeText(accountId, profile, String(input.text)),
    computer_key: async (input) => pressKeys(accountId, profile, String(input.key)),
    web_fetch: async (input) => {
      const parentPeek = opts?.fetchChars != null;
      const page = await webFetch(accountId, profile, String(input.url), parentPeek ? { dispatcherPeek: true } : undefined);
      const byline = [page.siteName, page.byline].filter((part) => part.length > 0).join(" · ");
      const body = [
        `# ${page.title || "(no title)"}${byline ? `\n${byline}` : ""}`,
        `Source: ${page.url}${page.rendered ? " (JS-rendered)" : ""}${page.truncated ? " [truncated]" : ""}`,
        "",
        page.markdown,
      ].join("\n");
      const cap = opts?.fetchChars ?? WORKER_OUTPUT_CHARS;
      if (body.length > cap) {
        return `${body.slice(0, cap)}\n\n[truncated to ${cap} chars — fetch a more specific page or use a focused search]`;
      }
      return body;
    },
    web_search: async (input) => {
      const query = String(input.query);
      const numResults = typeof input.numResults === "number" ? input.numResults : undefined;
      const [braveKey, exaKey] = await Promise.all([
        toolKeyFor(db, accountId, "brave").catch(() => null),
        toolKeyFor(db, accountId, "exa").catch(() => null),
      ]);
      const searched = await webSearch(accountId, profile, query, { numResults, braveKey, exaKey });
      if (searched.results.length === 0) {
        const via = searched.fallbackFrom ? `${searched.fallbackFrom} then ${searched.provider}` : searched.provider;
        if (searched.error) return `Search failed (${via}): ${searched.error}`;
        return `No results (${via}). Try different words or spawn_worker for deep research.`;
      }
      const via =
        searched.fallbackFrom != null
          ? `${searched.provider} (fallback after ${searched.fallbackFrom})`
          : searched.provider;
      return [
        `Search via ${via}:`,
        ...searched.results.map((row, index) => `${index + 1}. ${row.title}\n   ${row.url}\n   ${row.snippet}`),
      ].join("\n");
    },
    glob: async (input) => globFiles(accountId, profile, String(input.pattern), typeof input.path === "string" ? input.path : undefined),
    grep: async (input) =>
      grepFiles(accountId, profile, String(input.pattern), {
        path: typeof input.path === "string" ? input.path : undefined,
        include: typeof input.include === "string" ? input.include : undefined,
      }),
    browser_list_pages: () => runBrowserTool(accountId, profile, "browser_list_pages", {}),
    browser_navigate: (input) => runBrowserTool(accountId, profile, "browser_navigate", input),
    browser_snapshot: () => runBrowserTool(accountId, profile, "browser_snapshot", {}),
    browser_click: (input) => runBrowserTool(accountId, profile, "browser_click", input),
    browser_fill: (input) => runBrowserTool(accountId, profile, "browser_fill", input),
    browser_press_key: (input) => runBrowserTool(accountId, profile, "browser_press_key", input),
    browser_handle_dialog: (input) => runBrowserTool(accountId, profile, "browser_handle_dialog", input),
    browser_wait_for: (input) => runBrowserTool(accountId, profile, "browser_wait_for", input),
  };
}

/**
 * Bounds one raw text result before it becomes multi-step model history.
 * Why: command/file output is resent on every later model step; retaining a
 * focused prefix and an explicit narrowing instruction keeps context useful
 * without ending the task or imposing a total-token cutoff.
 */
function conciseOutput(text: string, limit = WORKER_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated to ${limit} chars — rerun with a narrower command, range, or filter]`;
}
