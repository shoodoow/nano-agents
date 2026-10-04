/**
 * One-shot MCP caller. Core docker-execs this inside the account container.
 *
 * Why this exists: shell exec only runs a command. An MCP server needs a short
 * HTTP session (initialize, session id, then tools/list or tools/call), and the
 * bearer secret must stay out of the model's command line. This script reads the
 * URL and secret from /var/nano/mcp (synced by core), makes that call, and exits.
 * It does not listen, so no MCP port is published on the host.
 *
 * Reads JSON from stdin: { op: "list"|"call", slug, tool, arguments }. Prints JSON.
 */
import { readFile } from "node:fs/promises";

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function serverFor(slug) {
  const raw = await readFile("/var/nano/mcp/servers.json", "utf8");
  const servers = JSON.parse(raw);
  const server = servers.find((row) => row.slug === slug);
  if (!server?.url) throw new Error(`No MCP server named ${slug} in this computer.`);
  let secret = "";
  try {
    secret = (await readFile(`/var/nano/mcp/secrets/${slug}`, "utf8")).trim();
  } catch {
    secret = "";
  }
  return { url: server.url, secret };
}

function headers(secret, session) {
  const out = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (secret) out.authorization = secret.startsWith("Bearer ") ? secret : `Bearer ${secret}`;
  if (session) out["mcp-session-id"] = session;
  return out;
}

async function rpc(url, secret, session, body) {
  const response = await fetch(url, { method: "POST", headers: headers(secret, session), body: JSON.stringify(body) });
  const nextSession = response.headers.get("mcp-session-id") || session;
  const text = await response.text();
  let parsed = null;
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  const jsonText = dataLine ? dataLine.slice(5).trim() : text;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) throw new Error(parsed?.error?.message || text.slice(0, 500) || `MCP HTTP ${response.status}`);
  return { session: nextSession, parsed };
}

async function openSession(url, secret) {
  const init = await rpc(url, secret, undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "nano-agents", version: "0" },
    },
  });
  await fetch(url, {
    method: "POST",
    headers: headers(secret, init.session),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => {});
  return init.session;
}

async function main() {
  const request = JSON.parse(await readStdin());
  const { url, secret } = await serverFor(String(request.slug));
  const session = await openSession(url, secret);
  if (request.op === "list") {
    const listed = await rpc(url, secret, session, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = listed.parsed?.result?.tools ?? [];
    process.stdout.write(JSON.stringify({ tools }));
    return;
  }
  if (request.op === "call") {
    const called = await rpc(url, secret, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: request.tool, arguments: request.arguments ?? {} },
    });
    process.stdout.write(JSON.stringify(called.parsed?.result ?? called.parsed));
    return;
  }
  throw new Error("MCP bridge op must be list or call.");
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
