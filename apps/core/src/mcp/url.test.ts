import { describe, expect, it } from "vitest";
import { assertSafeMcpUrl, isBlockedMcpHost } from "./url.js";

describe("MCP URL cage", () => {
  it("blocks private and local hosts", () => {
    expect(isBlockedMcpHost("127.0.0.1")).toBe(true);
    expect(isBlockedMcpHost("10.0.0.4")).toBe(true);
    expect(isBlockedMcpHost("192.168.1.9")).toBe(true);
    expect(isBlockedMcpHost("host.docker.internal")).toBe(true);
    expect(() => assertSafeMcpUrl("http://127.0.0.1:9222")).toThrow(/public endpoints/);
    expect(() => assertSafeMcpUrl("https://example.com/mcp")).not.toThrow();
  });
});
