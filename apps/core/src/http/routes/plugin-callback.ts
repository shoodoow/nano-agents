import { Router } from "express";
import { finishGoogleOAuth } from "../../mcp/google-oauth.js";
import { finishMcpOAuth } from "../../mcp/mcp-oauth.js";
import { peekPending } from "../../mcp/oauth-pending.js";
import type { AppContext } from "../context.js";

/**
 * The page an OAuth provider sends the browser back to after plugin consent.
 * Why no session guard: the browser arrives from another site without the
 * app's session. The unguessable state id from the start call names the account.
 * Input: the request context. Output: the router.
 */
export function pluginCallbackRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get("/plugins/oauth/callback", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const oauthError = typeof req.query.error === "string" ? req.query.error : "";
    if (oauthError || !code || !state) {
      res.status(400).type("html").send(pluginPage("The plugin was not connected."));
      return;
    }
    try {
      const pending = peekPending(state);
      if (!pending) throw new Error("This plugin sign-in expired. Start it again.");
      const name = pending.kind === "google" ? (await finishGoogleOAuth(ctx.db, state, code)).name : (await finishMcpOAuth(ctx.db, state, code)).slug;
      res.type("html").send(pluginPage(`${name} is connected. You can close this window.`));
    } catch (error) {
      res.status(400).type("html").send(pluginPage(error instanceof Error ? error.message : "The plugin was not connected."));
    }
  });
  return router;
}

function pluginPage(message: string): string {
  const safe = message.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] ?? char);
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plugin</title><body style="font-family:sans-serif;padding:24px"><p>${safe}</p><script>location.href=${JSON.stringify("nano-agents://plugins")}</script>`;
}
