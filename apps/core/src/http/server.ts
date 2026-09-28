import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import express, { Router, type Express, type NextFunction, type Request, type Response } from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { createAuth, localBrowserOrigins } from "../auth/auth.js";
import { handBack, profileOnAccount, startDesktop, takeOver } from "../desktop/desktop.js";
import type { getDb } from "../db/client.js";
import { listProviderKeys, saveProviderKey } from "../keys/keys.js";
import { createProfile, pipeExec } from "../linux/linux.js";
import { buildInstructions } from "../prompt/build-instructions.js";
import { addMember, createRoom, listConversations, listMessages, readMessage, RoomCapacityError } from "../rooms/rooms.js";
import { runTurn, type TurnInput } from "../rooms/turn.js";
import { createAccount, createAgent, getAgent, listAgents, updateAgentFlags } from "../roster/roster.js";
import { approve, listProposals, reject } from "../skills/proposals.js";

type Database = ReturnType<typeof getDb>;
type Auth = ReturnType<typeof createAuth>;

type AppContext = {
  db: Database;
  auth: Auth;
  generate?: (input: TurnInput) => Promise<string>;
};

const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  redact: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"],
});

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
  const auth = createAuth(db);
  const app = createApp({ db, auth, generate });
  const server = createServer(app);
  server.on("upgrade", (request, socket, head) => {
    proxyScreen(db, auth, request, socket, head).catch((error: unknown) => {
      logger.error({ err: error }, "screen proxy failed");
      socket.destroy();
    });
  });
  const host = process.env.HOST ?? "127.0.0.1";
  return new Promise<Server>((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      logger.info({ host, port: typeof address === "object" && address ? address.port : port }, "core listening");
      resolve(server);
    });
  });
}

/**
 * Builds the Express application.
 * Input: the database, auth instance, and optional model call.
 * Output: the app. Auth is mounted before the JSON parser so Better Auth can read the raw body.
 */
function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  if (process.env.TRUST_PROXY === "1") {
    app.set("trust proxy", 1);
  }

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url?.split("?")[0] === "/health" },
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && /^[\w.-]{1,128}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
      customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) {
          return "error";
        }
        if (res.statusCode >= 400) {
          return "warn";
        }
        return "info";
      },
    }),
  );
  app.use(securityHeaders);
  app.use(localCors);

  const authHandler = toNodeHandler(ctx.auth);
  app.all("/api/auth/*splat", (req, res, next) => {
    Promise.resolve(authHandler(req, res)).catch(next);
  });

  app.use(express.json({ limit: "1mb", type: acceptsJson }));
  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  mountRoutes(app, ctx);
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });
  app.use(onError);
  return app;
}

/**
 * Mounts the account, room, agent, and proposal routes.
 * Input: the Express app and the request context.
 * Output: nothing. Each route checks the signed-in account except the test-only account create route.
 */
function mountRoutes(app: Express, ctx: AppContext): void {
  const guard = requireSession(ctx.auth);

  if (process.env.NODE_ENV === "test") {
    app.post("/accounts", async (req, res) => {
      res.status(201).json(await createAccount(ctx.db, req.body));
    });
  }

  const accounts = Router();
  accounts.get("/:accountId/providers", guard, async (req, res) => {
    res.json(await listProviderKeys(ctx.db, pathParam(req, "accountId")));
  });
  accounts.put("/:accountId/providers", guard, async (req, res) => {
    res.json(await saveProviderKey(ctx.db, pathParam(req, "accountId"), req.body));
  });
  accounts.get("/:accountId/agents", guard, async (req, res) => {
    res.json(await listAgents(ctx.db, pathParam(req, "accountId")));
  });
  accounts.post("/:accountId/agents", guard, async (req, res) => {
    res.status(201).json(await createAgent(ctx.db, pathParam(req, "accountId"), req.body));
  });
  accounts.get("/:accountId/conversations", guard, async (req, res) => {
    res.json(await listConversations(ctx.db, pathParam(req, "accountId")));
  });
  accounts.post("/:accountId/conversations", guard, async (req, res) => {
    const accountId = pathParam(req, "accountId");
    const created = await createRoom(ctx.db, accountId, req.body);
    if (!created) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    for (const member of created.members) {
      await createProfile(ctx.db, accountId, member.agentId);
    }
    res.status(201).json(created);
  });
  accounts.get("/:accountId/proposals", guard, async (req, res) => {
    res.json(await listProposals(ctx.db, pathParam(req, "accountId")));
  });
  accounts.post("/:accountId/screens/:profile/takeover", guard, (req, res) => setScreen(ctx.db, req, res, "takeover"));
  accounts.post("/:accountId/screens/:profile/handback", guard, (req, res) => setScreen(ctx.db, req, res, "handback"));
  app.use("/accounts", accounts);

  const conversations = Router();
  conversations.get("/:conversationId/messages", guard, async (req, res) => {
    const rows = await listMessages(ctx.db, queryAccountId(req), pathParam(req, "conversationId"));
    if (!rows) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.json(rows);
  });
  conversations.post("/:conversationId/messages", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const conversationId = pathParam(req, "conversationId");
    const body = await readMessage(ctx.db, accountId, conversationId, req.body);
    if (!body) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    const replies = await runTurn(ctx.db, accountId, conversationId, body, ctx.generate);
    res.status(201).json({ replies });
  });
  conversations.post("/:conversationId/members", guard, async (req, res) => {
    const created = await addMember(ctx.db, queryAccountId(req), pathParam(req, "conversationId"), req.body);
    if (!created) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.status(201).json(created);
  });
  app.use("/conversations", conversations);

  const proposals = Router();
  proposals.post("/:proposalId/approve", guard, async (req, res) => {
    const updated = await approve(ctx.db, queryAccountId(req), pathParam(req, "proposalId"), process.env.SKILLS_DIR);
    if (!updated) {
      res.status(404).json({ error: "Proposal not found." });
      return;
    }
    res.json(updated);
  });
  proposals.post("/:proposalId/reject", guard, async (req, res) => {
    const updated = await reject(ctx.db, queryAccountId(req), pathParam(req, "proposalId"));
    if (!updated) {
      res.status(404).json({ error: "Proposal not found." });
      return;
    }
    res.json(updated);
  });
  app.use("/proposals", proposals);

  const agents = Router();
  agents.patch("/:agentId", guard, async (req, res) => {
    const updated = await updateAgentFlags(ctx.db, queryAccountId(req), pathParam(req, "agentId"), req.body);
    if (!updated) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    res.json(updated);
  });
  agents.get("/:agentId/prompt", guard, async (req, res) => {
    const agent = await getAgent(ctx.db, queryAccountId(req), pathParam(req, "agentId"));
    if (!agent) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    res.json({ prompt: buildInstructions(agent.description) });
  });
  agents.get("/:agentId", guard, async (req, res) => {
    const agent = await getAgent(ctx.db, queryAccountId(req), pathParam(req, "agentId"));
    if (!agent) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    res.json(agent);
  });
  app.use("/agents", agents);
}

/**
 * Pauses or resumes one profile's pointer.
 * Input: the database, the request, the response, and takeover or handback.
 * Output: nothing. A profile outside the account is a 404.
 */
async function setScreen(db: Database, req: Request, res: Response, action: "takeover" | "handback"): Promise<void> {
  const accountId = pathParam(req, "accountId");
  const profile = pathParam(req, "profile");
  const owned = await profileOnAccount(db, accountId, profile);
  if (!owned) {
    res.status(404).json({ error: "Screen not found." });
    return;
  }
  if (action === "takeover") {
    takeOver(accountId, profile);
  } else {
    handBack(accountId, profile);
  }
  res.json({ ok: true });
}

/**
 * Requires the signed-in user to own the account in the path or query.
 * Input: the Better Auth instance.
 * Output: route middleware. Tests skip the check so fixtures can call the API directly.
 */
function requireSession(auth: Auth) {
  return async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (process.env.NODE_ENV === "test") {
      next();
      return;
    }
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    const sessionAccountId = String((session.user as { accountId?: string | null }).accountId ?? "");
    if (!sessionAccountId || sessionAccountId !== requestedAccountId(req)) {
      res.status(403).json({ error: "This account is not available to this session." });
      return;
    }
    next();
  };
}

/**
 * Proxies one profile's noVNC connection through the core.
 * Input: the database, the upgrade request, the client socket, and bytes already read.
 * Output: nothing. The client talks to that profile's desktop and never receives the container port.
 */
async function proxyScreen(db: Database, auth: Auth, request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const match = url.pathname.match(/^\/accounts\/([^/]+)\/screens\/([^/]+)$/);
  if (!match) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const accountId = match[1] ?? "";
  if (process.env.NODE_ENV !== "test") {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    const sessionAccountId = String((session?.user as { accountId?: string | null } | undefined)?.accountId ?? "");
    if (!session || sessionAccountId !== accountId) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
  }
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
  logger.info({ accountId, profile }, "screen proxy opened");
  await pipeExec(accountId, ["socat", "STDIO", `TCP:127.0.0.1:${session.novncPort}`], socket, preamble);
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  next();
}

function localCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && localBrowserOrigins().includes(origin)) {
    const requested = req.headers["access-control-request-headers"];
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-headers", Array.isArray(requested) ? requested.join(", ") : (requested ?? "content-type"));
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
  }
  next();
}

function onError(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    return;
  }
  if (error instanceof RoomCapacityError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof Error && error.name === "ZodError") {
    res.status(400).json({ error: error.message });
    return;
  }
  const status = clientStatus(error);
  if (status === 413) {
    res.status(413).json({ error: "Request body is too large." });
    return;
  }
  if (status !== undefined) {
    const parseFailed = typeof error === "object" && error !== null && "type" in error && error.type === "entity.parse.failed";
    const message = error instanceof Error && error.message ? error.message : "Request failed.";
    res.status(status).json({ error: parseFailed ? "Request body must be JSON." : message });
    return;
  }
  logger.error({ err: error }, "request failed");
  const message = process.env.NODE_ENV === "production" || !(error instanceof Error) ? "Request failed." : error.message;
  res.status(500).json({ error: message });
}

function acceptsJson(req: IncomingMessage): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return false;
  }
  const header = req.headers["content-type"];
  if (typeof header !== "string" || header.length === 0) {
    return true;
  }
  const type = header.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json") || type === "text/plain";
}

function requestedAccountId(req: Request): string {
  return pathParam(req, "accountId") || queryAccountId(req);
}

function queryAccountId(req: Request): string {
  const value = req.query.accountId;
  return typeof value === "string" ? value : "";
}

function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === "string" ? value : "";
}

function clientStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = error.status;
  if (typeof status !== "number" || status < 400 || status >= 500) {
    return undefined;
  }
  return status;
}
