import { fromNodeHeaders } from "better-auth/node";
import type { NextFunction, Request, Response } from "express";
import type { createAuth } from "../auth/auth.js";
import type { getDb } from "../db/client.js";
import type { GenerateResult, TurnInput } from "../rooms/turn.js";

export type Database = ReturnType<typeof getDb>;
export type Auth = ReturnType<typeof createAuth>;
export type Generate = (input: TurnInput) => Promise<GenerateResult>;

/** What every route needs: the database, sign-in, and the model call a test may replace. */
export type AppContext = {
  db: Database;
  auth: Auth;
  generate?: Generate;
  /** True for a fixture server on this machine: no session check, open account creation. */
  openAccess: boolean;
};

export type Guard = ReturnType<typeof requireSession>;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { logger } from "../log/logger.js";

/**
 * Requires the signed-in user to own the account in the path or query.
 * Input: the request context.
 * Output: route middleware. A server started with openAccess skips the check.
 */
export function requireSession(ctx: Pick<AppContext, "auth" | "openAccess">) {
  return async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (ctx.openAccess || res.locals.sessionChecked === true) {
      next();
      return;
    }
    const session = await ctx.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) {
      res.status(401).json({ error: "Sign in required." });
      return;
    }
    const sessionAccountId = String((session.user as { accountId?: string | null }).accountId ?? "");
    if (!sessionAccountId || sessionAccountId !== requestedAccountId(req)) {
      res.status(403).json({ error: "This account is not available to this session." });
      return;
    }
    res.locals.sessionChecked = true;
    next();
  };
}

export function requestedAccountId(req: Request): string {
  // The body parser runs before any router, so params may not be filled yet.
  const fromPath = pathParam(req, "accountId") || /^\/accounts\/([^/]+)/.exec(req.path)?.[1] || "";
  return fromPath || queryAccountId(req);
}

export function queryAccountId(req: Request): string {
  const value = req.query.accountId;
  return typeof value === "string" ? value : "";
}

export function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === "string" ? value : "";
}
