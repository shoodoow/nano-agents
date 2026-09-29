import { exec } from "../linux/linux.js";

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchProvider = "brave" | "exa" | "duckduckgo";

const MAX_RESULTS = 10;
const SEARCH_TIMEOUT = 20;

// Fixed API hosts (Phase 15): no user-supplied host ever reaches curl, so
// this tool needs no SSRF gate beyond the allowlisted endpoints below.
const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";
const EXA_URL = "https://api.exa.ai/search";
const DUCK_URL = "https://lite.duckduckgo.com/lite/";

/**
 * Picks the search provider by key availability.
 * Why: keyed APIs beat scraping on quality; account keys beat env keys on
 * isolation; DuckDuckGo needs no key so search always works. Pure for tests.
 * Input: available keys. Output: brave > exa > duckduckgo.
 */
export function selectSearchProvider(keys: { braveKey?: string | null; exaKey?: string | null }): SearchProvider {
  if (keys.braveKey) return "brave";
  if (keys.exaKey) return "exa";
  return "duckduckgo";
}

/**
 * Searches the web from inside the account container.
 * Why: tenant egress belongs to the tenant's Linux, never the core host —
 * same rule as web_fetch. Runs the provider chain and truncates to a
 * model-sized answer.
 * Input: account id, profile (exec user), query, count, resolved keys.
 * Output: {provider, results} with capped titles/snippets.
 */
export async function webSearch(
  accountId: string,
  profile: string,
  query: string,
  input: { numResults?: number; braveKey?: string | null; exaKey?: string | null } = {},
): Promise<{ provider: SearchProvider; results: SearchResult[] }> {
  const clean = query.trim().slice(0, 500);
  if (!clean) throw new Error("A search query is required.");
  const count = Math.min(Math.max(input.numResults ?? 8, 1), MAX_RESULTS);
  const provider = selectSearchProvider(input);
  if (provider === "brave") {
    const raw = await curl(
      accountId,
      profile,
      `${BRAVE_URL}?q=${encodeURIComponent(clean)}&count=${count}`,
      ["-H", `X-Subscription-Token: ${input.braveKey}`],
    );
    return { provider, results: parseBraveResponse(raw).slice(0, count) };
  }
  if (provider === "exa") {
    const body = JSON.stringify({ query: clean, numResults: count, type: "auto" }).replaceAll("'", `'\\''`);
    const raw = await curl(accountId, profile, EXA_URL, ["-H", "Content-Type: application/json", "-H", `x-api-key: ${input.exaKey}`, "-d", body]);
    return { provider, results: parseExaResponse(raw).slice(0, count) };
  }
  const raw = await curl(accountId, profile, `${DUCK_URL}?q=${encodeURIComponent(clean)}`, []);
  return { provider, results: parseDuckLite(raw).slice(0, count) };
}

/**
 * GETs/POSTs one allowlisted URL from the container with a hard timeout.
 * Why: single choke point — curl flags fixed here, callers only add headers.
 * Input: account, profile, full URL, extra curl args. Output: stdout text.
 */
async function curl(accountId: string, profile: string, url: string, extra: string[]): Promise<string> {
  const quoted = `'${url.replaceAll("'", `'\\''`)}'`;
  const args = ["curl", "-sS", "--max-time", String(SEARCH_TIMEOUT), "--max-redirs", "3", ...extra, quoted];
  const result = await exec(accountId, args, profile);
  return result.stdout.slice(0, 200_000);
}

/**
 * Parses Brave web_search JSON into results.
 * Why: pure so provider mapping is unit-tested without keys or network.
 * Input: raw JSON text. Output: capped results (empty on garbage).
 */
export function parseBraveResponse(raw: string): SearchResult[] {
  try {
    const data = JSON.parse(raw) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (data.web?.results ?? []).map((row) => ({
      title: String(row.title ?? "Untitled").slice(0, 200),
      url: String(row.url ?? ""),
      snippet: String(row.description ?? "").slice(0, 500),
    })).filter((row) => row.url.startsWith("http"));
  } catch {
    return [];
  }
}

/**
 * Parses Exa search JSON into results.
 * Why: same purity contract as Brave — mapping tested, network mocked out.
 * Input: raw JSON text. Output: capped results (empty on garbage).
 */
export function parseExaResponse(raw: string): SearchResult[] {
  try {
    const data = JSON.parse(raw) as { results?: { title?: string; url?: string; text?: string }[] };
    return (data.results ?? []).map((row) => ({
      title: String(row.title ?? "Untitled").slice(0, 200),
      url: String(row.url ?? ""),
      snippet: String(row.text ?? "").slice(0, 500),
    })).filter((row) => row.url.startsWith("http"));
  } catch {
    return [];
  }
}

/**
 * Scrapes DuckDuckGo lite HTML into results.
 * Why: keyless fallback keeps search working with zero setup; fragile by
 * nature, so failures yield [] (caller reports "no results") instead of
 * throwing. Pure and regex-bound for tests.
 * Input: lite HTML. Output: title/url/snippet triples in page order.
 */
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
