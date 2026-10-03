import { JSDOM, VirtualConsole } from "jsdom";
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import TurndownService from "turndown";
import { exec } from "../linux/linux.js";

/** Suppresses jsdom's noisy "Could not parse CSS stylesheet" on modern pages. */
function quietConsole(): VirtualConsole {
  const console = new VirtualConsole();
  console.on("jsdomError", () => {});
  return console;
}

// Why: "go look at this site" is core agent work, but the box ships no curl
// and raw HTML rarely answers anyway. Two tiers: fast static fetch for docs
// and text pages, headless Chromium render for JS-heavy sites (like skill
// directories). Runs INSIDE the account container so egress belongs to the
// tenant, never the core host. Private ranges are refused (SSRF guard).
const STATIC_MAX_BYTES = 500_000;
const TEXT_MAX_CHARS = 15_000;

export type FetchedPage = {
  url: string;
  title: string;
  byline: string;
  siteName: string;
  markdown: string;
  truncated: boolean;
  rendered: boolean;
};

/**
 * Rejects non-public fetch targets.
 * Why: the container shares a Docker network with the host; loopback,
 * private ranges, link-local (cloud metadata 169.254.169.254), and .local
 * names could reach host services. Pure for testing.
 * Input: raw url string. Output: normalized https/http URL or throws.
 */
export function safeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("That is not a valid URL. Use a full https:// address.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only https:// and http:// pages can be fetched.");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\.0\.0\.0$/.test(host)
  ) {
    throw new Error("That address is not fetchable (private or local range).");
  }
  if (raw.length > 2_048) {
    throw new Error("That URL is too long.");
  }
  return parsed.toString();
}

/**
 * Converts a page to LLM-ready Markdown with resolved links.
 * Why: raw HTML buries meaning in nav/chrome markup, and naive tag-stripping
 * destroys the structure models reason over (headings, lists, tables, code).
 * The proven pipeline — Readability extracts the article, Turndown renders it
 * as Markdown — keeps semantics while dropping boilerplate. Non-article
 * pages (homepages, leaderboards) fall back to full-body conversion so
 * nothing real is ever discarded for being unscored.
 * Input: raw html + page url for resolving relatives. Output: title, byline,
 * site, markdown, and whether Reader mode succeeded.
 */
export function htmlToMarkdown(
  html: string,
  pageUrl: string,
): { title: string; byline: string; siteName: string; markdown: string; usedReader: boolean } {
  const dom = new JSDOM(html, { url: pageUrl, virtualConsole: quietConsole() });
  const document = dom.window.document;
  absolutizeLinks(document, pageUrl);
  stripBoilerplate(document);
  // Readability drops <pre> blocks it deems chrome — yet install commands
  // and snippets are the highest-value bytes for an agent. Lift them out
  // first (stripping the nodes so neither path double-emits), re-attach fenced.
  const codeSamples = collectCodeSamples(document);
  const codeSection =
    codeSamples.length > 0
      ? `\n\n## Code samples\n\n${codeSamples.map((sample) => `\`\`\`${sample.lang}\n${sample.code}\n\`\`\``).join("\n\n")}`
      : "";
  if (isProbablyReaderable(document)) {
    try {
      const article = new Readability(document.cloneNode(true) as Document).parse();
      const textLength = article?.textContent?.trim().length ?? 0;
      if (article?.content && textLength > 200) {
        return {
          title: (article.title ?? "").trim(),
          byline: (article.byline ?? "").trim(),
          siteName: (article.siteName ?? "").trim(),
          markdown: toMarkdown(article.content) + codeSection,
          usedReader: true,
        };
      }
    } catch {
      // Reader choked on this DOM: fall through to full-body conversion.
    }
  }
  const title = document.querySelector("title")?.textContent?.trim() ?? "";
  const body = document.body ?? document;
  return { title, byline: "", siteName: "", markdown: toMarkdown(body) + codeSection, usedReader: false };
}

/**
 * Lifts code samples out of the DOM before extraction.
 * Why: Readability silently drops <pre> blocks, and Turndown only fences
 * what survives — either way the agent loses install commands. Collecting
 * upfront (max 10 × 2000 chars) preserves them verbatim with language tags.
 * Input: live document (mutated: pre nodes removed). Output: samples.
 */
function collectCodeSamples(document: Document): { lang: string; code: string }[] {
  const samples: { lang: string; code: string }[] = [];
  for (const pre of document.querySelectorAll("pre")) {
    if (samples.length >= 10) break;
    const code = pre.textContent?.trim() ?? "";
    if (code.length < 2) continue;
    const langMatch = /language-([A-Za-z0-9+-]+)/.exec(pre.querySelector("code")?.className ?? pre.className ?? "");
    samples.push({ lang: langMatch?.[1] ?? "", code: code.slice(0, 2000) });
    pre.remove();
  }
  return samples;
}

/**
 * Removes non-content elements before extraction.
 * Why: embedded JSON blobs (__NEXT_DATA__), scripts, and styles leak through
 * Turndown as text noise — on skills.sh the skill rows drowned in escaped
 * JSON. Reader mode cleans some of this, but the fallback path needs it
 * stripped upfront too.
 * Input: live document (mutated). Output: nothing.
 */
function stripBoilerplate(document: Document): void {
  for (const node of document.querySelectorAll("script, style, noscript, template")) {
    node.remove();
  }
}

/**
 * Renders a DOM subtree as Markdown with absolute link targets.
 * Why: single Turndown configuration (ATX headings, fenced code) so every
 * page reaches the model in one predictable dialect. Input: element or html
 * string. Output: markdown, whitespace-collapsed.
 */
function toMarkdown(root: unknown): string {
  const service = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  const out = service.turndown(root as never);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Resolves relative href/src attributes to absolute https/http URLs in place.
 * Why: Turndown copies hrefs verbatim — a relative "/s/seo" is useless to the
 * model. Non-web schemes (javascript:, mailto:, data:) are unwired so they
 * render as plain text instead of traps.
 * Input: live document + page url. Output: nothing (mutates the DOM).
 */
function absolutizeLinks(document: Document, pageUrl: string): void {
  for (const anchor of document.querySelectorAll("a[href]")) {
    try {
      const href = new URL(anchor.getAttribute("href") ?? "", pageUrl).toString();
      if (href.startsWith("https:") || href.startsWith("http:")) {
        anchor.setAttribute("href", href);
      } else {
        anchor.removeAttribute("href");
      }
    } catch {
      anchor.removeAttribute("href");
    }
  }
  for (const image of document.querySelectorAll("img[src]")) {
    try {
      const src = new URL(image.getAttribute("src") ?? "", pageUrl).toString();
      if (src.startsWith("https:") || src.startsWith("http:")) {
        image.setAttribute("src", src);
      } else {
        image.removeAttribute("src");
      }
    } catch {
      image.removeAttribute("src");
    }
  }
}

/**
 * Fetches one public page as grounded text.
 * Why: single entry for the model tool. Static wget first (fast, no
 * browser); when the text is suspiciously thin the page is likely
 * client-rendered, so Chromium headless dumps the live DOM instead.
 * Input: account id, profile (for user-scoped exec), raw url.
 * Output: title, capped text, truncation flag, outlinks, rendered flag.
 */
export async function webFetch(accountId: string, profile: string, rawUrl: string): Promise<FetchedPage> {
  const url = safeUrl(rawUrl);
  const quoted = `'${url.replaceAll("'", `'\\''`)}'`;
  const staticResult = await exec(
    accountId,
    [
      "sh",
      "-c",
      `wget -qO- --timeout=20 --tries=1 --max-redirect=5 -U 'nano-agents/1' --header='Accept: text/html' ${quoted} 2>/dev/null | head -c ${STATIC_MAX_BYTES}`,
    ],
    profile,
  );
  let html = staticResult.stdout;
  let rendered = false;
  if (html.trim().length < 500) {
    // Real --timeout wait, not virtual-time: virtual budgets freeze network
    // fetches, so client-rendered rows (skill leaderboards) never hydrate.
    // Proven against skills.sh: rows appear only with a genuine wait.
    const dom = await exec(
      accountId,
      [
        "sh",
        "-c",
        `timeout 60 chromium --headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu --timeout=30000 --dump-dom ${quoted} 2>/dev/null | head -c ${STATIC_MAX_BYTES}`,
      ],
      profile,
    );
    if (dom.stdout.trim().length > html.trim().length) {
      html = dom.stdout;
      rendered = true;
    }
  }
  if (html.trim().length === 0) {
    throw new Error("The page came back empty. It may block bots, need a login, or be unreachable from the computer.");
  }
  const parsed = htmlToMarkdown(html, url);
  const truncated = parsed.markdown.length > TEXT_MAX_CHARS;
  return {
    url,
    title: parsed.title,
    byline: parsed.byline,
    siteName: parsed.siteName,
    markdown: truncated ? `${parsed.markdown.slice(0, TEXT_MAX_CHARS)}\n\n[truncated — fetch a linked sub-page for more]` : parsed.markdown,
    truncated,
    rendered,
  };
}
