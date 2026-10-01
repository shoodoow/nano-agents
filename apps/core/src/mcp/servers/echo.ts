/**
 * Sample MCP server (stdio): tool `echo` — for local protocol testing only.
 * Logs to stderr only; stdout is the JSON-RPC stream.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "nano-echo", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echo text back (sample MCP server).",
    inputSchema: z.object({
      text: z.string().describe("Text to echo"),
    }),
  },
  async ({ text }) => ({
    content: [{ type: "text", text: JSON.stringify({ echo: text.trim(), from: "mcp-echo-server" }) }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
