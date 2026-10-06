/**
 * One-shot Chrome DevTools helper. Core docker-execs this inside the account container.
 *
 * Why this exists: bash and other tools already run in the container, but Chrome's
 * debugging port is a WebSocket on 127.0.0.1 (one port per agent display). That address is this container's
 * own loopback, so the main server cannot open it, and we do not publish the port
 * on the host. This script speaks CDP locally, then exits. It does not listen.
 *
 * Reads one JSON object from stdin: { tool, args }. Prints text to stdout.
 */
import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";

const CDP_HOST = "127.0.0.1";

function resolveCdpPort(request) {
  const fromBody = Number(request?.cdpPort);
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  const fromEnv = Number(process.env.NANO_CDP_PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 9222;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function getJson(path, cdpPort) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: CDP_HOST, port: cdpPort, path }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
  });
}

function putJson(path, cdpPort) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: CDP_HOST, port: cdpPort, path, method: "PUT" }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve(text ? JSON.parse(text) : {});
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function activateTarget(cdpPort, targetId) {
  if (!targetId) return;
  try {
    await getJson(`/json/activate/${targetId}`, cdpPort);
  } catch {
    // Best-effort: navigation still succeeded on the CDP browser.
  }
}

/** Prefer the newest real tab; optional URL hint after navigate. */
function pickPage(pages, preferUrl) {
  const candidates = pages.filter((row) => row.type === "page" && row.webSocketDebuggerUrl);
  if (candidates.length === 0) return null;
  if (preferUrl) {
    const hint = String(preferUrl);
    const exact = candidates.find((row) => row.url === hint);
    if (exact) return exact;
    const prefix = candidates.find((row) => row.url.startsWith(hint.split("?")[0]));
    if (prefix) return prefix;
  }
  const real = candidates.filter((row) => !row.url.startsWith("about:") && !row.url.startsWith("chrome://"));
  return (real.length > 0 ? real[real.length - 1] : candidates[candidates.length - 1]) ?? candidates[0];
}

function connectCdp(wsUrl) {
  const url = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port || 80), url.hostname);
    const key = crypto.randomBytes(16).toString("base64");
    let header = "";
    const messages = [];
    let buffer = Buffer.alloc(0);
    let opened = false;
    const pending = new Map();
    let nextId = 1;

    function send(method, params) {
      const id = nextId++;
      const data = Buffer.from(JSON.stringify({ id, method, params: params ?? {} }));
      if (data.length > 65_535) {
        return Promise.reject(new Error("CDP payload is too large for this bridge."));
      }
      const mask = crypto.randomBytes(4);
      let header;
      if (data.length < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x81;
        header[1] = 0x80 | data.length;
        mask.copy(header, 2);
      } else {
        header = Buffer.alloc(8);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(data.length, 2);
        mask.copy(header, 4);
      }
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, masked]));
      return new Promise((ok, fail) => {
        pending.set(id, { ok, fail });
      });
    }

    function takeFrame() {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        return;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 1) {
        try {
          const message = JSON.parse(payload.toString("utf8"));
          if (message.id && pending.has(message.id)) {
            const waiter = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) waiter.fail(new Error(message.error.message || "CDP error"));
            else waiter.ok(message.result);
          } else {
            messages.push(message);
          }
        } catch {
          // ignore non-json frames
        }
      }
      takeFrame();
    }

    socket.on("data", (chunk) => {
      if (!opened) {
        header += chunk.toString("utf8");
        if (!header.includes("\r\n\r\n")) return;
        if (!header.includes("101")) {
          reject(new Error("Chrome refused the debugging socket."));
          socket.destroy();
          return;
        }
        opened = true;
        const rest = header.slice(header.indexOf("\r\n\r\n") + 4);
        header = "";
        buffer = Buffer.from(rest);
        resolve({ send, close: () => socket.end(), messages });
        takeFrame();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      takeFrame();
    });
    socket.on("error", reject);
    socket.write(
      `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });
}

async function pageSocket(cdpPort, preferUrl) {
  const pages = await getJson("/json/list", cdpPort);
  const page = pickPage(pages, preferUrl);
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(
      `No Chrome page. Start Chromium on your DISPLAY with --remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}.`,
    );
  }
  await activateTarget(cdpPort, page.id);
  const local = page.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://${CDP_HOST}:${cdpPort}`);
  return connectCdp(local);
}

async function navigateVisible(cdpPort, url) {
  const target = String(url);
  let opened = null;
  try {
    opened = await putJson(`/json/new?${encodeURIComponent(target)}`, cdpPort);
  } catch {
    opened = null;
  }
  if (opened?.id) {
    await activateTarget(cdpPort, opened.id);
    return { frameId: opened.id, url: opened.url ?? target, openedNewTab: true };
  }
  const cdp = await pageSocket(cdpPort);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  const result = await cdp.send("Page.navigate", { url: target });
  await cdp.send("Page.bringToFront").catch(() => {});
  cdp.close();
  return { ...result, openedNewTab: false };
}

const SNAPSHOT = `(() => {
  let n = 0;
  const lines = [];
  const nodes = document.querySelectorAll("a,button,input,textarea,select,[role=button],[role=dialog],[aria-label]");
  for (const el of nodes) {
    const uid = "e" + (++n);
    el.setAttribute("data-nano-uid", uid);
    const label = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("value") || "").replace(/\\s+/g, " ").slice(0, 80);
    lines.push(uid + " " + el.tagName.toLowerCase() + " " + label);
    if (n >= 80) break;
  }
  const dialogs = [...document.querySelectorAll("[role=dialog], .modal, .popup, [class*=ad]")].slice(0, 5).map((el) => (el.innerText || "").replace(/\\s+/g, " ").slice(0, 120));
  return JSON.stringify({ url: location.href, title: document.title, lines, dialogs });
})()`;

async function main() {
  const raw = await readStdin();
  const request = JSON.parse(raw);
  const tool = request.tool;
  const args = request.args ?? {};
  const cdpPort = resolveCdpPort(request);
  if (tool === "browser_list_pages") {
    const pages = await getJson("/json/list", cdpPort);
    process.stdout.write(JSON.stringify(pages.map((page) => ({ id: page.id, title: page.title, url: page.url, type: page.type }))));
    return;
  }
  if (tool === "browser_navigate") {
    const result = await navigateVisible(cdpPort, String(args.url));
    process.stdout.write(JSON.stringify(result));
    return;
  }
  const preferUrl = typeof args.url === "string" ? args.url : undefined;
  const cdp = await pageSocket(cdpPort, preferUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  if (tool === "browser_snapshot") {
    const result = await cdp.send("Runtime.evaluate", { expression: SNAPSHOT, returnByValue: true });
    process.stdout.write(String(result.result?.value ?? ""));
  } else if (tool === "browser_click" || tool === "browser_fill") {
    const uid = String(args.uid);
    const expression =
      tool === "browser_click"
        ? `(() => { const el = document.querySelector('[data-nano-uid="${uid}"]'); if (!el) return null; const r = el.getBoundingClientRect(); el.click(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`
        : `(() => { const el = document.querySelector('[data-nano-uid="${uid}"]'); if (!el) return null; el.focus(); return "ok"; })()`;
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.result?.value == null) throw new Error(`No element ${uid}. Take a fresh browser_snapshot.`);
    if (tool === "browser_fill") {
      await cdp.send("Input.insertText", { text: String(args.value ?? "") });
    }
    process.stdout.write(String(result.result.value));
  } else if (tool === "browser_press_key") {
    const key = String(args.key);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key });
    process.stdout.write(`Pressed ${key}`);
  } else if (tool === "browser_handle_dialog") {
    await cdp.send("Page.handleJavaScriptDialog", {
      accept: Boolean(args.accept),
      promptText: args.promptText ? String(args.promptText) : undefined,
    });
    process.stdout.write(args.accept ? "Accepted dialog" : "Dismissed dialog");
  } else if (tool === "browser_wait_for") {
    const needle = JSON.stringify(String(args.text));
    const expression = `document.body && document.body.innerText.includes(${needle})`;
    let seen = false;
    for (let i = 0; i < 10; i++) {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
      if (result.result?.value === true) {
        seen = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    process.stdout.write(seen ? "Text is on the page." : "Timed out waiting for that text.");
  } else {
    throw new Error(`Unknown tool ${tool}`);
  }
  cdp.close();
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
