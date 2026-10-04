/**
 * Validates MCP HTTP URLs.
 * Why: tenant connectors are called from inside the account container, so a
 * localhost, private, or metadata address would let one cage aim at the host
 * or at another tenant. Public HTTPS only in production; private hosts never.
 */
export function assertSafeMcpUrl(value: string): void {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error("The MCP URL cannot contain credentials.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The MCP URL must use HTTP or HTTPS.");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("A production MCP URL must use HTTPS.");
  }
  if (isBlockedMcpHost(url.hostname)) {
    throw new Error(
      "MCP URLs must be public endpoints. Private, local, and in-container addresses are not allowed.",
    );
  }
}

export function isBlockedMcpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "host.docker.internal" || host === "metadata.google.internal" || host === "metadata.google.internal.") {
    return true;
  }
  if (host === "::1" || host === "0.0.0.0") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}
