import { Router, type Request, type Response } from "express";
import express from "express";
import { join } from "node:path";
import { novncRoot, novncShell, novncShellScript } from "../desktop/novnc.js";

const PREFIX = "/assets/novnc";

/**
 * Serves the noVNC client library from the installed package.
 * Input: nothing. Output: a router that mounts the library read-only.
 *
 * The library is third-party source with no session data in it, so it needs no
 * guard. It is mounted per subdirectory rather than at the package root so
 * docs and metadata stay unreachable, and express.static blocks traversal.
 */
export function novncAssets(): Router {
  const router = Router();
  const root = novncRoot();
  if (!root) {
    router.get(`${PREFIX}/*`, (_req: Request, res: Response) => {
      res.status(503).json({ error: "The desktop viewer is not installed on this server." });
    });
    return router;
  }
  const options = { index: false, dotfiles: "deny" as const, redirect: false, fallthrough: true };
  router.get(`${PREFIX}/shell.js`, (_req: Request, res: Response) => {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.send(novncShellScript(PREFIX));
  });
  router.use(`${PREFIX}/core`, express.static(join(root, "core"), options));
  router.use(`${PREFIX}/vendor`, express.static(join(root, "vendor"), options));
  return router;
}

/**
 * Serves the HTML shell that hosts noVNC inside the app's WebView.
 * Input: the request and response.
 * Output: nothing. The response is a self-contained page.
 *
 * Deliberately unauthenticated: the shell is a fixed document with no account
 * data, and it answers identically for real and unknown profiles so it cannot
 * be used to probe which agents exist. The RFB WebSocket it opens stays behind
 * the session and ownership checks in proxyScreen, which is the real boundary.
 */
export function novncClientPage(_req: Request, res: Response): void {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src * ws: wss:; img-src data:",
  );
  res.send(novncShell(PREFIX));
}
