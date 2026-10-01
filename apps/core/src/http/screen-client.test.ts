import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { novncAssets, novncClientPage } from "./screen-client.js";

describe("noVNC client routes", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    const app = express();
    app.get("/accounts/:accountId/screens/:profile/client", novncClientPage);
    app.use(novncAssets());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("serves the shell with a policy that blocks inline and remote scripts", async () => {
    const response = await fetch(`${baseUrl}/accounts/acct-1/screens/uabc/client`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    const html = await response.text();
    // The viewer must boot from the served script, never from an inline blob.
    expect(html).toContain('<script type="module" src="/assets/novnc/shell.js"></script>');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);
  });

  it("answers identically for profiles that do not exist", async () => {
    const [real, fake] = await Promise.all([
      fetch(`${baseUrl}/accounts/acct-1/screens/uabc/client`),
      fetch(`${baseUrl}/accounts/acct-1/screens/does-not-exist/client`),
    ]);
    expect(fake.status).toBe(real.status);
    // No oracle: the bytes must not reveal whether the agent exists.
    expect(await fake.text()).toBe(await real.text());
  });

  it("serves the shell script as a module", async () => {
    const response = await fetch(`${baseUrl}/assets/novnc/shell.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("/assets/novnc/core/rfb.js");
    expect(body).toContain("new RFB(");
  });

  it("serves the noVNC entry module and its transitive imports", async () => {
    const entry = await fetch(`${baseUrl}/assets/novnc/core/rfb.js`);
    expect(entry.status).toBe(200);
    const source = await entry.text();
    const imports = [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(5);
    // Every relative import the entry module names has to resolve, or the page
    // loads its modules and then sits on "Connecting" with no error.
    for (const specifier of imports) {
      const url = new URL(`/assets/novnc/core/${specifier}`, baseUrl);
      const response = await fetch(url);
      expect(`${url.pathname} -> ${response.status}`).toBe(`${url.pathname} -> 200`);
    }
  });

  it("does not expose package metadata outside the library directories", async () => {
    for (const path of ["/assets/novnc/package.json", "/assets/novnc/core/package.json", "/assets/novnc"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect([404, 403], `${path} must not be served`).toContain(response.status);
    }
  });

  it("blocks path traversal out of the library directories", async () => {
    for (const path of [
      "/assets/novnc/core/../../../../package.json",
      "/assets/novnc/vendor/%2e%2e/%2e%2e/package.json",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
      const body = await response.text();
      expect(body, `${path} must not leak package contents`).not.toContain("\"name\": \"@novnc/novnc\"");
    }
  });
});
