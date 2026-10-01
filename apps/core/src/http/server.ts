import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import express, { Router, type Express, type NextFunction, type Request, type Response } from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { deviceSchema } from "@nano-agents/shared";
import { reactionSchema, subagentCreateSchema } from "@nano-agents/agent-tools";
import { createAuth, localBrowserOrigins } from "../auth/auth.js";
import { handBack, profileOnAccount, startDesktop, takeOver } from "../desktop/desktop.js";
import { novncAssets, novncClientPage } from "./screen-client.js";
import type { getDb } from "../db/client.js";
import { devices, notifications } from "../db/schema.js";
import { and, desc, eq } from "drizzle-orm";
import { deleteMcpServer, listMcpServers, saveMcpServer } from "../mcp/store.js";
import { listProviderKeys, saveProviderKey } from "../keys/keys.js";
import { createProfile, pipeExec } from "../linux/linux.js";
import { buildInstructions } from "../prompt/build-instructions.js";
import {
  addMember,
  createRoom,
  getMessage,
  listConversations,
  listMembers,
  listMessages,
  listReactions,
  readMessage,
  saveUserMessage,
  RoomCapacityError,
} from "../rooms/rooms.js";
import { runTurn, type TurnInput } from "../rooms/turn.js";
import { acquireRun } from "../rooms/runs.js";
import { listEventsSince } from "../rooms/events.js";
import { attach, publish, type StreamEvent } from "../rooms/stream.js";
import { saveReaction } from "../rooms/send-message.js";
import type { TurnEvent } from "../rooms/send-message.js";
import { createAccount, createAgent, getAgent, listAgents, updateAgentFlags, AgentNameError } from "../roster/roster.js";
import { hireSubagent, listTeam } from "../rooms/subagents.js";
import { approve, listProposals, reject } from "../skills/proposals.js";

type Database = ReturnType<typeof getDb>;
type Auth = ReturnType<typeof createAuth>;

type AppContext = {
  db: Database;
  auth: Auth;
  generate?: (input: TurnInput) => Promise<string | { text: string }>;
};

// Live fanout lives in rooms/stream.ts (shared with the scheduler); the
// durable twin is the events table, replayed by cursor below.
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

  // 12mb because a single message can carry phone attachments: image/file
  // blocks allow data: URIs up to 8MB, and base64 has no JSON-escapable
  // characters, so the JSON body is roughly the attachment size. Per-block
  // caps in @nano-agents/shared stay the real guard; this only stops
  // absurd payloads. Single-tenant local core, not a public API.
  app.use(express.json({ limit: "12mb", type: acceptsJson }));
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
  accounts.get("/:accountId/mcp", guard, async (req, res) => {
    res.json(await listMcpServers(ctx.db, pathParam(req, "accountId")));
  });
  accounts.put("/:accountId/mcp", guard, async (req, res) => {
    res.json(await saveMcpServer(ctx.db, pathParam(req, "accountId"), req.body));
  });
  accounts.delete("/:accountId/mcp/:slug", guard, async (req, res) => {
    await deleteMcpServer(ctx.db, pathParam(req, "accountId"), pathParam(req, "slug"));
    res.status(204).end();
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
    // Profiles are idempotent (existing usernames return as-is), so a retry
    // after a computer failure heals without duplicating anything. The room
    // itself is kept so the retry has something to attach to.
    try {
      for (const member of created.members) {
        await createProfile(ctx.db, accountId, member.agentId);
      }
    } catch (error) {
      logger.error({ err: error, accountId }, "agent profile setup failed");
      res.status(503).json({ error: "The account computer is starting. Retry in a few seconds." });
      return;
    }
    res.status(201).json(created);
  });
  accounts.get("/:accountId/proposals", guard, async (req, res) => {
    res.json(await listProposals(ctx.db, pathParam(req, "accountId")));
  });
  accounts.post("/:accountId/screens/:profile/takeover", guard, (req, res) => setScreen(ctx.db, req, res, "takeover"));
  accounts.post("/:accountId/screens/:profile/handback", guard, (req, res) => setScreen(ctx.db, req, res, "handback"));
  accounts.get("/:accountId/screens/:profile/client", novncClientPage);
  accounts.post("/:accountId/uploads", guard, async (req, res) => {
    // Scoped under the account so requireSession can match the session's
    // accountId. A standalone /uploads route has no account context and can
    // only 403 — that was the "account is not available" bug on attach.
    // Minimal URL-accepting upload: the phone sends an https URL or a data:
    // URI (images, text, pdf, json) from the picker. Why no disk writes:
    // binary blobs belong in object storage (S3 seam); rows store the URL,
    // not bytes, keeping Postgres small and prompts bounded. data: URIs are
    // mime-allowlisted so the row cannot smuggle executables.
    const { url, name, mime } = req.body ?? {};
    if (typeof url !== "string" || url.length === 0 || url.length > 8_000_000) {
      res.status(400).json({ error: "url is required (https or data: base64, <=8MB)." });
      return;
    }
    const ok =
      url.startsWith("data:image/") ||
      /^data:(text\/[a-z0-9.+-]+|application\/(pdf|json));base64,/.test(url) ||
      (() => {
        try {
          return new URL(url).protocol === "https:";
        } catch {
          return false;
        }
      })();
    if (!ok) {
      res.status(400).json({ error: "Only https URLs or image/text/pdf/json data URIs are accepted." });
      return;
    }
    res.status(201).json({ url, name: typeof name === "string" ? name : "upload", mime: typeof mime === "string" ? mime : null });
  });
  app.use("/accounts", accounts);
  app.use(novncAssets());

  const conversations = Router();
  conversations.get("/:conversationId/messages", guard, async (req, res) => {
    const rows = await listMessages(ctx.db, queryAccountId(req), pathParam(req, "conversationId"));
    if (!rows) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.json(rows);
  });
  conversations.get("/:conversationId/reactions", guard, async (req, res) => {
    res.json(await listReactions(ctx.db, queryAccountId(req), pathParam(req, "conversationId")));
  });
  conversations.get("/:conversationId/blob/:messageId/:index", guard, async (req, res) => {
    // Serves one stripped attachment's bytes for lazy image rendering.
    // Ownership re-checked per request; index selects the block in payload.
    const accountId = queryAccountId(req);
    const conversationId = pathParam(req, "conversationId");
    const row = await getMessage(ctx.db, accountId, conversationId, pathParam(req, "messageId"));
    const index = Number(pathParam(req, "index"));
    const blocks = Array.isArray(row?.payload) ? (row.payload as Record<string, unknown>[]) : [];
    const block = Number.isInteger(index) ? blocks[index] : undefined;
    const url = typeof block?.url === "string" ? (block.url as string) : "";
    const preview = typeof block?.previewUrl === "string" ? (block.previewUrl as string) : "";
    if (!row || !block || (url === "" && preview === "")) {
      res.status(404).json({ error: "Attachment not found." });
      return;
    }
    res.json({ url: url !== "" ? url : undefined, previewUrl: preview !== "" ? preview : undefined });
  });
  conversations.post("/:conversationId/reactions", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const conversationId = pathParam(req, "conversationId");
    const room = await listMessages(ctx.db, accountId, conversationId);
    if (!room) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    const parsed = reactionSchema.parse(req.body);
    const saved = await ctx.db.transaction(async (tx) =>
      saveReaction(tx as never, {
        accountId,
        conversationId,
        agentId: null,
        messageId: parsed.messageId,
        emoji: parsed.emoji,
      }),
    );
    publish(accountId, conversationId, { type: "reaction", reaction: saved as never });
    res.status(201).json(saved);
  });
  conversations.get("/:conversationId/stream", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const conversationId = pathParam(req, "conversationId");
    const rows = await listMessages(ctx.db, accountId, conversationId);
    if (!rows) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`event: ready\ndata: {"conversationId":"${conversationId}"}\n\n`);
    // Resume: replay exactly what the client missed since its cursor, then
    // attach to live fanout. A phone closed for an hour replays the tail and
    // continues live with no gap and no duplicates (client dedups by cursor).
    // Absent cursor = live-only (fresh loads already fetched the thread);
    // present cursor (even 0) = replay everything after it.
    const rawCursor = req.query.cursor;
    const parsedCursor = typeof rawCursor === "string" && rawCursor !== "" ? Number(rawCursor) : NaN;
    if (Number.isFinite(parsedCursor) && parsedCursor >= 0) {
      const missed = await listEventsSince(ctx.db, accountId, conversationId, Math.floor(parsedCursor), 200);
      for (const row of missed) {
        res.write(`data: ${JSON.stringify({ ...(row.payload as Record<string, unknown>), cursor: row.id, conversationId })}\n\n`);
      }
    }
    const detach = attach(res, accountId, conversationId);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        // Closed; interval cleared below.
      }
    }, 25000);
    if (typeof (heartbeat as unknown as { unref?: () => void }).unref === "function") {
      (heartbeat as unknown as { unref: () => void }).unref();
    }
    req.on("close", () => {
      clearInterval(heartbeat);
      detach();
    });
  });
  conversations.post("/:conversationId/messages", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const conversationId = pathParam(req, "conversationId");
    const incoming = await readMessage(ctx.db, accountId, conversationId, req.body);
    if (!incoming) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    const onEvent = (event: StreamEvent) => publish(accountId, conversationId, event);
    const runJoined = (existingRunId: string, userMessage: { id: string }) =>
      runTurn(ctx.db, accountId, conversationId, incoming, ctx.generate as never, process.env.SKILLS_DIR, {
        onEvent,
        alreadySavedUserMessage: { id: userMessage.id, text: incoming.text },
        existingRunId,
      });
    // ?sync=1 preserves the legacy blocking contract for tests and scripts:
    // claim with waiting, run inline, return replies.
    if (req.query.sync === "1") {
      const run = await acquireRun(ctx.db, accountId, conversationId, "turn");
      const userMessage = await saveUserMessage(ctx.db, accountId, conversationId, {
        text: incoming.text,
        blocks: incoming.blocks,
        replyTo: incoming.replyTo,
        runId: run.id,
      });
      if (!userMessage) {
        res.status(404).json({ error: "Room not found." });
        return;
      }
      const replies = await runJoined(run.id, userMessage);
      res.status(201).json({ message: userMessage, replies });
      return;
    }
    // Default is fail-fast claim + 202: free room -> run now in background
    // (closing the phone never kills the turn); busy room -> message saved
    // queued, and the running turn starts it the moment that turn ends.
    // HTTP never waits on model work.
    try {
      const run = await acquireRun(ctx.db, accountId, conversationId, "turn", 0);
      const userMessage = await saveUserMessage(ctx.db, accountId, conversationId, {
        text: incoming.text,
        blocks: incoming.blocks,
        replyTo: incoming.replyTo,
        runId: run.id,
      });
      if (!userMessage) {
        res.status(404).json({ error: "Room not found." });
        return;
      }
      void runJoined(run.id, userMessage).catch((error: unknown) => {
        // runTurn already failed the run + emitted the error event; this only logs.
        logger.error({ err: error, conversationId }, "background turn failed");
      });
      res.status(202).json({
        accepted: true,
        message: userMessage,
        stream: `/conversations/${conversationId}/stream?accountId=${accountId}`,
      });
    } catch (error) {
      if (error instanceof Error && /busy/.test(error.message)) {
        const userMessage = await saveUserMessage(ctx.db, accountId, conversationId, {
          text: incoming.text,
          blocks: incoming.blocks,
          replyTo: incoming.replyTo,
          queued: true,
        });
        res.status(202).json({
          accepted: true,
          queued: true,
          message: userMessage,
          stream: `/conversations/${conversationId}/stream?accountId=${accountId}`,
        });
        return;
      }
      throw error;
    }
  });
  conversations.post("/:conversationId/members", guard, async (req, res) => {
    const created = await addMember(ctx.db, queryAccountId(req), pathParam(req, "conversationId"), req.body);
    if (!created) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.status(201).json(created);
  });
  conversations.get("/:conversationId/members", guard, async (req, res) => {
    const rows = await listMembers(ctx.db, queryAccountId(req), pathParam(req, "conversationId"));
    if (!rows) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.json(rows);
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
    res.json({
      prompt: buildInstructions({
        name: agent.name,
        role: agent.role,
        personality: agent.personality,
        job: agent.jobDescription,
      }),
    });
  });
  agents.get("/:agentId", guard, async (req, res) => {
    const agent = await getAgent(ctx.db, queryAccountId(req), pathParam(req, "agentId"));
    if (!agent) {
      res.status(404).json({ error: "Agent not found." });
      return;
    }
    res.json(agent);
  });
  agents.get("/:agentId/team", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const agentId = pathParam(req, "agentId");
    res.json(await listTeam(ctx.db, accountId, agentId));
  });
  agents.post("/:agentId/subagents", guard, async (req, res) => {
    const accountId = queryAccountId(req);
    const parentAgentId = pathParam(req, "agentId");
    const data = subagentCreateSchema.parse(req.body);
    const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId : null;
    if (!conversationId) {
      res.status(400).json({ error: "conversationId is required to join the room." });
      return;
    }
    try {
      const child = await hireSubagent(ctx.db, {
        accountId,
        conversationId,
        parentAgentId,
        label: data.label,
        role: data.role,
        personality: data.personality,
        jobDescription: data.jobDescription,
        provider: data.provider,
        modelId: data.modelId,
      });
      // Best-effort OS user: the hire itself is the contract (201). If the
      // computer is down, the turn runner lazily provisions the profile on the
      // child's first speak, so we return the child instead of failing and
      // risking a duplicate on client retry.
      try {
        await createProfile(ctx.db, accountId, child.id);
      } catch (error) {
        logger.warn({ err: error, accountId, childId: child.id }, "subagent OS profile deferred to first turn");
      }
      res.status(201).json(child);
    } catch (error) {
      if (error instanceof RoomCapacityError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
  app.use("/agents", agents);

  const devicesRouter = Router();
  devicesRouter.post("/", guard, async (req, res) => {
    // Upserts one push device per account. Why: token refresh rotates the
    // ExpoPushToken — upsert on the token keeps exactly one row per device.
    // Invalid tokens 400 here so the phone can fall back to polling visibly.
    const data = deviceSchema.parse(req.body);
    const accountId = queryAccountId(req);
    const [existing] = await ctx.db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.expoPushToken, data.expoPushToken));
    if (existing) {
      await ctx.db
        .update(devices)
        .set({ accountId, platform: data.platform ?? null })
        .where(eq(devices.id, existing.id));
      res.json({ id: existing.id });
      return;
    }
    const [saved] = await ctx.db
      .insert(devices)
      .values({ accountId, expoPushToken: data.expoPushToken, platform: data.platform ?? null })
      .returning();
    res.status(201).json({ id: saved!.id });
  });
  app.use("/devices", devicesRouter);

  const notificationsRouter = Router();
  notificationsRouter.get("/", guard, async (req, res) => {
    // Pending pings for the badge/inbox. Why: pushes can be missed or
    // dismissed — the list is the durable fallback the phone reconciles on
    // every foreground, newest first, capped for cheap polling.
    const accountId = queryAccountId(req);
    const pendingOnly = req.query.pending !== "0";
    const rows = await ctx.db
      .select()
      .from(notifications)
      .where(
        pendingOnly
          ? and(eq(notifications.accountId, accountId), eq(notifications.status, "pending"))
          : eq(notifications.accountId, accountId),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    res.json(rows);
  });
  app.use("/notifications", notificationsRouter);
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
  if (error instanceof RoomCapacityError || error instanceof AgentNameError) {
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
