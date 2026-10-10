export type LinkMeta = { title: string | null; site: string | null; icon: string | null };

/** Host without "www.", read by regex so it works the same in tests and on device. */
export function hostOf(url: string): string {
  return (/^https?:\/\/([^/?#:]+)/i.exec(url)?.[1] ?? url).replace(/^www\./i, "");
}

/**
 * True when a link is safe for the phone to fetch by itself for a preview.
 * Why: an agent, or a web page an agent read, chooses the links in a chat. A
 * preview must not make the phone call a device on the home network or send
 * an unencrypted request, so only https to a named public host is fetched.
 */
export function isPreviewable(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  const host = hostOf(url).toLowerCase();
  if (!host.includes(".") || host.startsWith("[")) return false;
  if (/^\d+(\.\d+){3}$/.test(host)) return false;
  return !/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host);
}

export function originOf(url: string): string {
  return /^(https?:\/\/[^/?#]+)/i.exec(url)?.[1] ?? url;
}

/**
 * Reads the label and favicon a link card shows from a page's HTML head.
 * Input: the HTML (or its first part) and the page URL. Output: title, site
 * name, and an absolute icon URL. The icon falls back to /favicon.ico.
 */
export function parseLinkMeta(html: string, url: string): LinkMeta {
  const head = html.slice(0, 200_000);
  const title =
    metaContent(head, "og:title") ??
    metaContent(head, "twitter:title") ??
    /<title[^>]*>([^<]{1,300})<\/title>/i.exec(head)?.[1] ??
    null;
  const icon = iconHref(head);
  return {
    title: clean(title),
    site: clean(metaContent(head, "og:site_name")),
    icon: icon ? absoluteUrl(icon, url) : `${originOf(url)}/favicon.ico`,
  };
}

function metaContent(html: string, key: string): string | null {
  const tag = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i").exec(html)?.[0];
  return tag ? attribute(tag, "content") : null;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

/** Prefers the touch icon (a large PNG) over the tab icon, which is often a tiny .ico. */
function iconHref(html: string): string | null {
  let tab: string | null = null;
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attribute(tag, "rel") ?? "").toLowerCase();
    const href = attribute(tag, "href");
    if (!href) continue;
    if (rel.includes("apple-touch-icon")) return href;
    if (!tab && /(^|\s)icon(\s|$)/.test(rel)) tab = href;
  }
  return tab;
}

function absoluteUrl(href: string, pageUrl: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `${originOf(pageUrl)}${href}`;
  if (href.startsWith("data:")) return href;
  return `${originOf(pageUrl)}/${href.replace(/^\.\//, "")}`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function clean(value: string | null): string | null {
  if (!value) return null;
  const text = value
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (all, name: string) => ENTITIES[name.toLowerCase()] ?? all)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : null;
}
