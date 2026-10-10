import { describe, expect, it } from "vitest";
import { callMcpTool, listMcpTools } from "./client.js";

type Seen = { method: string; authorization: string | undefined; session: string | undefined };

/** A stand-in MCP server: answers initialize, tools/list and tools/call, and records what it was sent. */
function fakeServer(options?: { eventStream?: boolean; failCall?: boolean }) {
  const seen: Seen[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string; arguments?: unknown } };
    seen.push({ method: body.method, authorization: headers.authorization, session: headers["mcp-session-id"] });
    const reply = (result: unknown, status = 200) => {
      const json = JSON.stringify(result);
      return new Response(options?.eventStream ? `event: message\ndata: ${json}\n\n` : json, {
        status,
        headers: { "mcp-session-id": "session-1" },
      });
    };
    if (body.method === "initialize") return reply({ result: {} });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      return reply({ result: { tools: [{ name: "find", inputSchema: { type: "object" } }] } });
    }
    if (options?.failCall) return reply({ error: { message: "The token was refused." } }, 401);
    return reply({ result: { content: [{ type: "text", text: `ran ${body.params?.name}` }], echoed: body.params?.arguments } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe("MCP client on the core", () => {
  it("lists tools and sends the bearer and the session on every later message", async () => {
    const server = fakeServer();
    const tools = await listMcpTools("https://mcp.example.com/mcp", "secret-token", server.fetchImpl);
    expect(tools).toEqual([{ name: "find", description: "", inputSchema: { type: "object" } }]);
    expect(server.seen.map((message) => message.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(server.seen.every((message) => message.authorization === "Bearer secret-token")).toBe(true);
    expect(server.seen.map((message) => message.session)).toEqual([undefined, "session-1", "session-1"]);
  });

  it("calls a tool and reads an event-stream answer", async () => {
    const server = fakeServer({ eventStream: true });
    const result = await callMcpTool("https://mcp.example.com/mcp", "", "find", { q: "x" }, server.fetchImpl);
    expect(result).toEqual({ content: [{ type: "text", text: "ran find" }], echoed: { q: "x" } });
    expect(server.seen[0]?.authorization).toBeUndefined();
  });

  it("reports the server's own error message", async () => {
    const server = fakeServer({ failCall: true });
    await expect(callMcpTool("https://mcp.example.com/mcp", "t", "find", {}, server.fetchImpl)).rejects.toThrow(
      "The token was refused.",
    );
  });

  it("refuses a private address before any request is made", async () => {
    const server = fakeServer();
    await expect(listMcpTools("http://127.0.0.1:5432/mcp", "t", server.fetchImpl)).rejects.toThrow(/public endpoints/);
    await expect(listMcpTools("https://host.docker.internal/mcp", "t", server.fetchImpl)).rejects.toThrow();
    expect(server.seen).toHaveLength(0);
  });
});
