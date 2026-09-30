import { jsonSchema, tool } from "ai";
import type { getDb } from "../db/client.js";
import { toolKeyFor } from "../keys/tools.js";
import { accountHome, accountShared } from "../linux/linux.js";
import { bash, clickAt, moveMouse, pressKeys, readFile, screenshotImage, typeText, writeFile } from "./computer.js";
import { globFiles, grepFiles } from "./find.js";
import { webSearch } from "./search.js";
import { webFetch } from "./web.js";

type Database = ReturnType<typeof getDb>;

/**
 * Names of the tools that run on one agent's Linux profile.
 * Why: the prompt catalog, the chat turn, and the worker must offer the same
 * set. A second hand-written list is how web_search disappeared from workers.
 * Input: none. Output: sorted tool names.
 */
export function profileToolNames(): string[] {
  return [
    "bash",
    "computer_click",
    "computer_key",
    "computer_mouse",
    "computer_screenshot",
    "computer_type",
    "glob",
    "grep",
    "read",
    "web_fetch",
    "web_search",
    "write",
  ].sort();
}

/**
 * Builds the file, shell, desktop, and web tools for one Linux profile.
 * Why: the chatting agent and a background worker share one computer. Both
 * call this so a tool added here is callable in both places. Voice, team,
 * and routine tools stay on the turn; a worker must not receive those.
 * Input: database (search keys), account id, Linux username.
 * Output: AI SDK tool map keyed by profileToolNames().
 */
export function profileTools(db: Database, accountId: string, profile: string) {
  const home = accountHome(accountId, profile);
  const shared = accountShared(accountId);
  return {
    read: tool({
      description: `Read one file in ${home} or ${shared}. Use for a single known path. If you are the agent in the chat, hand a reading job to spawn_worker instead.`,
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      }),
      execute: async ({ path }) => readFile(accountId, profile, path),
    }),
    write: tool({
      description: `Write one file in ${home} or ${shared}. Use when you already know the path and the body. Project edits belong on a worker via spawn_worker.`,
      inputSchema: jsonSchema<{ path: string; body: string }>({
        type: "object",
        properties: { path: { type: "string" }, body: { type: "string" } },
        required: ["path"],
      }),
      execute: async ({ path, body }) => {
        await writeFile(accountId, profile, path, body);
        return "Wrote the file.";
      },
    }),
    bash: tool({
      description:
        "Run one shell command on your Linux computer. DISPLAY is already your 1280x800 desktop, so chromium and xterm open on the screen the person watches. Never start Xvfb/x11vnc or override DISPLAY. If you are the agent in the chat, hand real work to spawn_worker; use bash only for one quick command, or when you are the worker doing the task.",
      inputSchema: jsonSchema<{ command: string }>({
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      }),
      execute: async ({ command }) => bash(accountId, profile, command),
    }),
    computer_screenshot: tool({
      description:
        "PNG of your assigned 1280x800 desktop. Call before any click or type so coordinates match the screen. A desktop task belongs on a worker via spawn_worker so the chat stays free.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => screenshotImage(accountId, profile),
    }),
    computer_mouse: tool({
      description: "Move the pointer to x/y (0-1279, 0-799) without clicking. Screenshot first. Prefer computer_click when you mean to click.",
      inputSchema: jsonSchema<{ x: number; y: number }>({
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      }),
      execute: async ({ x, y }) => moveMouse(accountId, profile, x, y),
    }),
    computer_click: tool({
      description: "Move and left-click at x/y on your desktop in one step. Screenshot first. Prefer this over mouse plus a separate click.",
      inputSchema: jsonSchema<{ x: number; y: number }>({
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" } },
        required: ["x", "y"],
      }),
      execute: async ({ x, y }) => clickAt(accountId, profile, x, y),
    }),
    computer_type: tool({
      description: "Type 1-4000 characters into the focused desktop field. Click that field first. Driving a whole desktop session belongs on a worker.",
      inputSchema: jsonSchema<{ text: string }>({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      }),
      execute: async ({ text }) => typeText(accountId, profile, text),
    }),
    computer_key: tool({
      description: "Press one key combo: Return, Escape, Tab, arrows, F-keys, or ctrl/alt/shift+x. Use after the right control is focused.",
      inputSchema: jsonSchema<{ key: string }>({
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      }),
      execute: async ({ key }) => pressKeys(accountId, profile, key),
    }),
    web_fetch: tool({
      description:
        "Read one public page as text when you already have the URL — and when the person names a site (like skills.sh), fetch it FIRST before searching. JS-heavy pages render automatically. Returns title, text, and outlinks. Never send the person to their browser for a page you can open. Never end the turn asking for details when a fetch is untried.",
      inputSchema: jsonSchema<{ url: string }>({
        type: "object",
        properties: { url: { type: "string", description: "Full https:// address." } },
        required: ["url"],
      }),
      execute: async ({ url }) => {
        const page = await webFetch(accountId, profile, url);
        const byline = [page.siteName, page.byline].filter((part) => part.length > 0).join(" · ");
        return [
          `# ${page.title || "(no title)"}${byline ? `\n${byline}` : ""}`,
          `Source: ${page.url}${page.rendered ? " (JS-rendered)" : ""}${page.truncated ? " [truncated]" : ""}`,
          "",
          page.markdown,
        ].join("\n");
      },
    }),
    web_search: tool({
      description:
        "Search the public web. Returns title, URL, and snippet, not page text. Use to pick links, then web_fetch the ones worth reading. One empty result is not failure: retry with different words, then fetch the named site.",
      inputSchema: jsonSchema<{ query: string; numResults?: number }>({
        type: "object",
        properties: { query: { type: "string" }, numResults: { type: "number" } },
        required: ["query"],
      }),
      execute: async ({ query, numResults }) => {
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
    }),
    glob: tool({
      description: "List files by name pattern (for example **/*.ts) under your home or /shared, up to 100 paths. Use to find a file before read. A wide search belongs on a worker.",
      inputSchema: jsonSchema<{ pattern: string; path?: string }>({
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
      }),
      execute: async ({ pattern, path }) => globFiles(accountId, profile, pattern, path),
    }),
    grep: tool({
      description:
        "Search file contents for a pattern under your home or /shared. Returns file:line hits, up to 100. Use when you know the text but not the file. A broad hunt belongs on a worker.",
      inputSchema: jsonSchema<{ pattern: string; path?: string; include?: string }>({
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } },
        required: ["pattern"],
      }),
      execute: async ({ pattern, path, include }) => grepFiles(accountId, profile, pattern, { path, include }),
    }),
  };
}
