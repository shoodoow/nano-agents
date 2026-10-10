import { config } from "../config.js";
import { isPrivateHost } from "../net/public-address.js";

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
  if (config.isProduction() && url.protocol !== "https:") {
    throw new Error("A production MCP URL must use HTTPS.");
  }
  if (isBlockedMcpHost(url.hostname)) {
    throw new Error(
      "MCP URLs must be public endpoints. Private, local, and in-container addresses are not allowed.",
    );
  }
}

export function isBlockedMcpHost(hostname: string): boolean {
  return isPrivateHost(hostname);
}
