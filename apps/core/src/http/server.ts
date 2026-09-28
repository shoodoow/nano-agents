import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { buildInstructions } from "../prompt/build-instructions.js";
import type { getDb } from "../db/client.js";
import { addMember, createRoom, readMessage, RoomCapacityError } from "../rooms/rooms.js";
import { createAccount, createAgent, getAgent, listAgents, updateAgentFlags } from "../roster/roster.js";
import { approve, reject } from "../skills/proposals.js";
import { createProfile, pipeExec } from "../linux/linux.js";
import { handBack, profileOnAccount, startDesktop, takeOver } from "../desktop/desktop.js";
import { runTurn, type TurnInput } from "../rooms/turn.js";

type Database = ReturnType<typeof getDb>;

/**
 * Reads the request body as text.
 * Input: a Node request.
 * Output: the raw body string.
 */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * Sends a JSON response.
 * Input: the response, an HTTP status, and a JSON value.
 * Output: nothing. The response is ended.
 */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * Handles one core HTTP request.
 * Input: the database, the request, and the response.
 * Output: nothing. The response contains the account, agent, room, or prompt that was asked for.
 */
async function handle(
  db: Database,
  request: IncomingMessage,
  response: ServerResponse,
  generate?: (input: TurnInput) => Promise<string>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const accountMatch = url.pathname.match(/^\/accounts\/([^/]+)\/agents$/);
  const roomMatch = url.pathname.match(/^\/accounts\/([^/]+)\/conversations$/);
  const memberMatch = url.pathname.match(/^\/conversations\/([^/]+)\/members$/);
  const messageMatch = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
  const proposalMatch = url.pathname.match(/^\/proposals\/([^/]+)\/(approve|reject)$/);
  const screenMatch = url.pathname.match(/^\/accounts\/([^/]+)\/screens\/([^/]+)\/(takeover|handback)$/);
  const agentMatch = url.pathname.match(/^\/agents\/([^/]+)(\/prompt)?$/);

  if (request.method === "POST" && url.pathname === "/accounts") {
    const created = await createAccount(db, JSON.parse(await readBody(request)));
    sendJson(response, 201, created);
    return;
  }

  if (request.method === "GET" && accountMatch) {
    sendJson(response, 200, await listAgents(db, accountMatch[1] ?? ""));
    return;
  }

  if (request.method === "POST" && accountMatch) {
    const created = await createAgent(db, accountMatch[1] ?? "", JSON.parse(await readBody(request)));
    sendJson(response, 201, created);
    return;
  }

  if (request.method === "POST" && roomMatch) {
    const created = await createRoom(db, roomMatch[1] ?? "", JSON.parse(await readBody(request)));
    if (!created) {
      sendJson(response, 404, { error: "Agent not found." });
      return;
    }
    for (const member of created.members) {
      await createProfile(db, roomMatch[1] ?? "", member.agentId);
    }
    sendJson(response, 201, created);
    return;
  }

  if (request.method === "POST" && memberMatch) {
    const accountId = url.searchParams.get("accountId") ?? "";
    const created = await addMember(db, accountId, memberMatch[1] ?? "", JSON.parse(await readBody(request)));
    if (!created) {
      sendJson(response, 404, { error: "Room not found." });
      return;
    }
    sendJson(response, 201, created);
    return;
  }

  if (request.method === "POST" && messageMatch) {
    const accountId = url.searchParams.get("accountId") ?? "";
    const body = await readMessage(db, accountId, messageMatch[1] ?? "", JSON.parse(await readBody(request)));
    if (!body) {
      sendJson(response, 404, { error: "Room not found." });
      return;
    }
    const replies = await runTurn(db, accountId, messageMatch[1] ?? "", body, generate);
    sendJson(response, 201, { replies });
    return;
  }

  if (request.method === "POST" && screenMatch) {
    const accountId = screenMatch[1] ?? "";
    const profile = decodeURIComponent(screenMatch[2] ?? "");
    const owned = await profileOnAccount(db, accountId, profile);
    if (!owned) {
      sendJson(response, 404, { error: "Screen not found." });
      return;
    }
    if (screenMatch[3] === "takeover") {
      takeOver(accountId, profile);
    } else {
      handBack(accountId, profile);
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && proposalMatch) {
    const accountId = url.searchParams.get("accountId") ?? "";
    const proposalId = proposalMatch[1] ?? "";
    const updated =
      proposalMatch[2] === "approve"
        ? await approve(db, accountId, proposalId, process.env.SKILLS_DIR)
        : await reject(db, accountId, proposalId);
    if (!updated) {
      sendJson(response, 404, { error: "Proposal not found." });
      return;
    }
    sendJson(response, 200, updated);
    return;
  }

  if (request.method === "PATCH" && agentMatch && !agentMatch[2]) {
    const accountId = url.searchParams.get("accountId") ?? "";
    const updated = await updateAgentFlags(db, accountId, agentMatch[1] ?? "", JSON.parse(await readBody(request)));
    if (!updated) {
      sendJson(response, 404, { error: "Agent not found." });
      return;
    }
    sendJson(response, 200, updated);
    return;
  }

  if (request.method === "GET" && agentMatch && agentMatch[2] === "/prompt") {
    const accountId = url.searchParams.get("accountId") ?? "";
    const agent = await getAgent(db, accountId, agentMatch[1] ?? "");
    if (!agent) {
      sendJson(response, 404, { error: "Agent not found." });
      return;
    }
    sendJson(response, 200, { prompt: buildInstructions(agent.description) });
    return;
  }

  if (request.method === "GET" && agentMatch) {
    const accountId = url.searchParams.get("accountId") ?? "";
    const agent = await getAgent(db, accountId, agentMatch[1] ?? "");
    if (!agent) {
      sendJson(response, 404, { error: "Agent not found." });
      return;
    }
    sendJson(response, 200, agent);
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

/**
 * Proxies one profile's noVNC connection through the core.
 * Input: the database, the upgrade request, the client socket, and bytes already read.
 * Output: nothing. The client talks to that profile's desktop and never receives the container port.
 */
async function proxyScreen(db: Database, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const match = url.pathname.match(/^\/accounts\/([^/]+)\/screens\/([^/]+)$/);
  if (!match) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const accountId = match[1] ?? "";
  const profile = decodeURIComponent(match[2] ?? "");
  const owned = await profileOnAccount(db, accountId, profile);
  if (!owned) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const session = await startDesktop(accountId, profile);
  const lines = ["GET / HTTP/1.1", `Host: 127.0.0.1:${session.novncPort}`];
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name.toLowerCase() === "host") {
      continue;
    }
    lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
  }
  const preamble = Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), head]);
  await pipeExec(accountId, ["socat", "STDIO", `TCP:127.0.0.1:${session.novncPort}`], socket, preamble);
}

/**
 * Starts the core HTTP server.
 * Input: a database client, a port, and an optional model call. Port 0 asks the operating system for a free port.
 * Output: the listening server. Close it when the process should stop.
 */
export function startServer(
  db: Database,
  port: number,
  generate?: (input: TurnInput) => Promise<string>,
): Promise<Server> {
  const server = createServer((request, response) => {
    handle(db, request, response, generate).catch((error: unknown) => {
      if (error instanceof RoomCapacityError) {
        sendJson(response, 409, { error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : "Request failed.";
      sendJson(response, 400, { error: message });
    });
  });
  server.on("upgrade", (request, socket, head) => {
    proxyScreen(db, request, socket, head).catch(() => socket.destroy());
  });
  return new Promise<Server>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
