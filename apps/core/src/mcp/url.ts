/** Validates MCP HTTP URLs (no embedded credentials). */
export function assertSafeMcpUrl(value: string): void {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error("The MCP URL cannot contain credentials.");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("A production MCP URL must use HTTPS.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The MCP URL must use HTTP or HTTPS.");
  }
}
