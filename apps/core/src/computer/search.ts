import { exec } from "../linux/linux.js";

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchProvider = "brave" | "exa" | "duckduckgo";

export type WebSearchOutcome = {
  provider: SearchProvider;
  results: SearchResult[];
  /** Set when the primary provider returned nothing useful. */
  error?: string;
  fallbackFrom?: SearchProvider;
};

const MAX_RESULTS = 10;
const SEARCH_TIMEOUT = 20;

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const EXA_URL = "https://api.exa.ai/search";
const DUCK_URL = "https://lite.duckduckgo.com/lite/";

/**
 * Picks the search provider by key availability.
 * Why: Exa first — built for LLM agents (semantic + optional page text).
 * Brave second for classic web index; DuckDuckGo needs no key.
 */
export function selectSearchProvider(keys: { braveKey?: string | null; exaKey?: string | null }): SearchProvider {
  if (keys.exaKey) return "exa";
  if (keys.braveKey) return "brave";
  return "duckduckgo";
}

/** Alternate keyed provider when the primary returns zero rows. */
function alternateKeyedProvider(
  primary: SearchProvider,
  keys: { braveKey?: string | null; exaKey?: string | null },
): SearchProvider | null {
  if (primary === "exa" && keys.braveKey) return "brave";
  if (primary === "brave" && keys.exaKey) return "exa";
  return null;
}

export async function webSearch(
  accountId: string,
  profile: string,
  query: string,
  input: { numResults?: number; braveKey?: string | null; exaKey?: string | null } = {},
): Promise<WebSearchOutcome> {
  const clean = query.trim().slice(0, 500);
  if (!clean) throw new Error("A search query is required.");
  const count = Math.min(Math.max(input.numResults ?? 8, 1), MAX_RESULTS);
  const primary = selectSearchProvider(input);
  const first = await runProvider(accountId, profile, primary, clean, count, input);
  if (first.results.length > 0) return first;

  const alternate = alternateKeyedProvider(primary, input);
  if (alternate) {
    const second = await runProvider(accountId, profile, alternate, clean, count, input);
    if (second.results.length > 0) {
      return { ...second, fallbackFrom: primary, error: first.error };
    }
  }

  if (primary !== "duckduckgo") {
    const ddg = await runProvider(accountId, profile, "duckduckgo", clean, count, input);
    if (ddg.results.length > 0) {
      return { ...ddg, fallbackFrom: primary, error: first.error };
    }
  }

  return first;
}

async function runProvider(
  accountId: string,
  profile: string,
  provider: SearchProvider,
  query: string,
  count: number,
  input: { braveKey?: string | null; exaKey?: string | null },
): Promise<WebSearchOutcome> {
  if (provider === "brave") {
    const raw = await curlGet(
      accountId,
      profile,
      `${BRAVE_URL}?q=${encodeURIComponent(query)}&count=${count}`,
      [`X-Subscription-Token: ${input.braveKey}`],
    );
    const error = parseApiError(raw);
    return { provider, results: parseBraveResponse(raw).slice(0, count), error };
  }
  if (provider === "exa") {
    const raw = await curlPost(accountId, profile, EXA_URL, input.exaKey ?? "", {
      query,
      numResults: count,
      type: "auto",
      livecrawl: "fallback",
      contents: {
        text: { maxCharacters: 2_500 },
        summary: { query },
        highlights: { maxCharacters: 1_000, query },
      },
    });
    const error = parseApiError(raw);
    return { provider, results: parseExaResponse(raw).slice(0, count), error };
  }
  const raw = await curlGet(accountId, profile, `${DUCK_URL}?q=${encodeURIComponent(query)}`, []);
  return { provider, results: parseDuckLite(raw).slice(0, count) };
}

async function curlGet(accountId: string, profile: string, url: string, headers: string[]): Promise<string> {
  const args = ["curl", "-sS", "--max-time", String(SEARCH_TIMEOUT), "--max-redirs", "3"];
  for (const header of headers) args.push("-H", header);
  args.push(url);
  const result = await exec(accountId, args, profile);
  return result.stdout.slice(0, 200_000);
}

async function curlPost(accountId: string, profile: string, url: string, apiKey: string, body: unknown): Promise<string> {
  const args = [
    "curl",
    "-sS",
    "--max-time",
    String(SEARCH_TIMEOUT),
    "--max-redirs",
    "3",
    "-X",
    "POST",
    url,
    "-H",
    "Content-Type: application/json",
    "-H",
    `x-api-key: ${apiKey}`,
    "--data",
    JSON.stringify(body),
  ];
  const result = await exec(accountId, args, profile);
  return result.stdout.slice(0, 200_000);
}

/** Surfaces provider error JSON instead of silent empty lists. */
export function parseApiError(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const data = JSON.parse(trimmed) as { error?: string; message?: string; detail?: string };
    const msg = data.error ?? data.message ?? data.detail;
    return typeof msg === "string" && msg.length > 0 ? msg.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

export function parseBraveResponse(raw: string): SearchResult[] {
  try {
    const data = JSON.parse(raw) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (data.web?.results ?? [])
      .map((row) => ({
        title: String(row.title ?? "Untitled").slice(0, 200),
        url: String(row.url ?? ""),
        snippet: String(row.description ?? "").slice(0, 500),
      }))
      .filter((row) => row.url.startsWith("http"));
  } catch {
    return [];
  }
}

export function parseExaResponse(raw: string): SearchResult[] {
  try {
    const data = JSON.parse(raw) as {
      results?: {
        title?: string;
        url?: string;
        text?: string;
        highlights?: string[];
        summary?: string;
      }[];
    };
    return (data.results ?? [])
      .map((row) => {
        // Combine all evidence fields instead of first-nonempty: text carries
        // the page body, summary carries Exa's query-focused abstract, and
        // highlights carry the matched passages. One field alone is what made
        // snippets too thin to answer from.
        const parts = [
          typeof row.summary === "string" ? row.summary.trim() : "",
          Array.isArray(row.highlights) ? row.highlights.join(" ").trim() : "",
          typeof row.text === "string" ? row.text.trim() : "",
        ].filter((part) => part.length > 0);
        const seen = new Set<string>();
        const snippet = parts
          .filter((part) => {
            const key = part.slice(0, 80).toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .join("\n")
          .slice(0, 1_500);
        return {
          title: String(row.title ?? "Untitled").slice(0, 200),
          url: String(row.url ?? ""),
          snippet,
        };
      })
      .filter((row) => row.url.startsWith("http"));
  } catch {
    return [];
  }
}

export function parseDuckLite(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const linkPattern = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis;
  const snippetPattern = /class=["']result-snippet["'][^>]*>(.*?)<\/td>/gis;
  const links: { url: string; title: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) !== null && links.length < MAX_RESULTS) {
    const href = match[1] ?? "";
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    const url = uddg?.[1] ? decodeURIComponent(uddg[1]) : href;
    if (!url.startsWith("http")) continue;
    const title = (match[2] ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 200) || "Untitled";
    links.push({ url, title });
  }
  const snippets: string[] = [];
  while ((match = snippetPattern.exec(html)) !== null && snippets.length < MAX_RESULTS) {
    snippets.push((match[1] ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 500));
  }
  links.forEach((link, index) => {
    out.push({ title: link.title, url: link.url, snippet: snippets[index] ?? "" });
  });
  return out;
}
