import type { getDb } from "../db/client.js";
import { toolKeyFor } from "../keys/tools.js";
import { bash, clickAt, moveMouse, pressKeys, readFile, screenshotImage, typeText, writeFile } from "./computer.js";
import { globFiles, grepFiles } from "./find.js";
import { webSearch } from "./search.js";
import { webFetch } from "./web.js";

type Database = ReturnType<typeof getDb>;

export type LinuxToolExecute = (input: Record<string, unknown>) => Promise<unknown>;

/**
 * Execute bodies for Linux worker tools (schemas live in @nano-agents/agent-tools).
 * Why: one factory per worker run, so per-run budgets (screenshot cap) reset
 * with the run. Screenshots compound in model context — each one re-bills
 * every later step — so the camera stops after the budget and the worker
 * continues with DOM/text methods instead of burning millions of tokens.
 */
export function linuxToolExecutes(db: Database, accountId: string, profile: string): Record<string, LinuxToolExecute> {
  /** Screenshots this worker has taken. Reset per run by construction. */
  let screenshots = 0;
  const SCREENSHOT_BUDGET = 8;
  return {
    read: async (input) => readFile(accountId, profile, String(input.path)),
    write: async (input) => {
      await writeFile(accountId, profile, String(input.path), String(input.body));
      return "Wrote the file.";
    },
    bash: async (input) => bash(accountId, profile, String(input.command)),
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
      const page = await webFetch(accountId, profile, String(input.url));
      const byline = [page.siteName, page.byline].filter((part) => part.length > 0).join(" · ");
      return [
        `# ${page.title || "(no title)"}${byline ? `\n${byline}` : ""}`,
        `Source: ${page.url}${page.rendered ? " (JS-rendered)" : ""}${page.truncated ? " [truncated]" : ""}`,
        "",
        page.markdown,
      ].join("\n");
    },
    web_search: async (input) => {
      const query = String(input.query);
      const numResults = typeof input.numResults === "number" ? input.numResults : undefined;
      const [braveKey, exaKey] = await Promise.all([
        toolKeyFor(db, accountId, "brave").catch(() => null),
        toolKeyFor(db, accountId, "exa").catch(() => null),
      ]);
      const searched = await webSearch(accountId, profile, query, { numResults, braveKey, exaKey });
      if (searched.results.length === 0) return `No results (${searched.provider}). Try different words.`;
      return [
        `Search via ${searched.provider}:`,
        ...searched.results.map((row, index) => `${index + 1}. ${row.title}\n   ${row.url}\n   ${row.snippet}`),
      ].join("\n");
    },
    glob: async (input) => globFiles(accountId, profile, String(input.pattern), typeof input.path === "string" ? input.path : undefined),
    grep: async (input) =>
      grepFiles(accountId, profile, String(input.pattern), {
        path: typeof input.path === "string" ? input.path : undefined,
        include: typeof input.include === "string" ? input.include : undefined,
      }),
  };
}
