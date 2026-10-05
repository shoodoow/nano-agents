import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locates the noVNC client that ships in node_modules.
 * Input: nothing.
 * Output: the absolute path of the @novnc/novnc package root, or null when it
 * is not installed. The package blocks deep imports through its exports map,
 * so resolution walks up from this module instead of using require.resolve.
 */
export function novncRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "node_modules", "@novnc", "novnc");
    if (existsSync(join(candidate, "core", "rfb.js"))) {
      return candidate;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/**
 * Builds the HTML shell that hosts the noVNC client inside the app's WebView.
 * Input: the path prefix the client resolves its module imports against.
 * Output: a complete HTML document. It carries no session data, so it is
 * safe to serve without a cookie; the RFB connection it opens is what the
 * core actually authorizes.
 */
export function novncShell(assetBase: string): string {
  const base = assetBase.replace(/\/+$/, "").replace(/[^A-Za-z0-9/_-]/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Desktop</title>
<style>
  html, body { margin: 0; height: 100%; background: #111; overflow: hidden; }
  #screen { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  #screen canvas { max-width: 100%; max-height: 100%; }
</style>
</head>
<body>
<div id="screen"></div>
<script type="module" src="${base}/shell.js"></script>
</body>
</html>`;
}

/**
 * Builds the module the shell page loads.
 * Input: the path prefix the client resolves its module imports against.
 * Output: an ES module that drives noVNC and reports state to the phone.
 *
 * Kept as a separate file rather than an inline script so the page can run
 * under a script-src 'self' policy with no inline escape hatch.
 */
export function novncShellScript(assetBase: string): string {
  // Embedded as a JS string literal, so strip anything that could terminate it.
  const base = assetBase.replace(/\/+$/, "").replace(/[^A-Za-z0-9/_-]/g, "");
  return `import RFB from "${base}/core/rfb.js";

const post = (payload) => {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }
};

const screen = document.getElementById("screen");
const params = new URLSearchParams(window.location.search);
const url = params.get("url");
const passed = params.get("password") ?? "";

window.nanoRfb = null;

/**
 * Waits for the phone to plant the session cookie.
 *
 * iOS runs scripts injected before content load in a document whose origin is
 * not committed yet, and a cookie written there is discarded. The phone sets
 * the cookie again once the page has loaded and then raises this flag, so
 * connecting is deferred until a cookie is known to be readable rather than
 * racing the platform's document-start timing.
 */
const withSession = (start) => {
  if (window.__nanoNoSession) {
    post({ kind: "auth" });
    return;
  }
  if (window.__nanoSessionReady) {
    start();
    return;
  }
  const deadline = Date.now() + 20000;
  const poll = setInterval(() => {
    if (window.__nanoNoSession) {
      clearInterval(poll);
      post({ kind: "auth" });
    } else if (window.__nanoSessionReady) {
      clearInterval(poll);
      start();
    } else if (Date.now() > deadline) {
      clearInterval(poll);
      post({ kind: "auth" });
    }
  }, 100);
};

let trackpadWanted = params.get("trackpad") === "1";
let trackpadCleanup = null;

const fbToElement = (rfb, fbX, fbY) => {
  const scale = rfb._display.scale;
  const vp = rfb._display._viewportLoc;
  return { x: (fbX - vp.x) * scale, y: (fbY - vp.y) * scale };
};

const moveTrackpadPointer = (rfb, fbX, fbY) => {
  const w = rfb._display.width;
  const h = rfb._display.height;
  if (w <= 0 || h <= 0) {
    return;
  }
  fbX = Math.max(0, Math.min(w - 1, fbX));
  fbY = Math.max(0, Math.min(h - 1, fbY));
  rfb._trackpadFbX = fbX;
  rfb._trackpadFbY = fbY;
  const el = fbToElement(rfb, fbX, fbY);
  rfb._flushMouseMoveTimer(el.x, el.y);
  rfb._sendMouse(el.x, el.y, rfb._mouseButtonMask);
  const canvas = rfb._canvas;
  const rect = canvas.getBoundingClientRect();
  const clientX = rect.left + (el.x / canvas.width) * rect.width;
  const clientY = rect.top + (el.y / canvas.height) * rect.height;
  rfb._cursor.move(clientX, clientY);
};

const applyTrackpad = (rfb, on) => {
  if (trackpadCleanup) {
    trackpadCleanup();
    trackpadCleanup = null;
  }
  trackpadWanted = on;
  if (!on) {
    rfb._gestures.attach(rfb._canvas);
    return;
  }
  rfb._gestures.detach();
  rfb.showDotCursor = true;
  if (rfb._trackpadFbX == null) {
    rfb._trackpadFbX = rfb._display.width / 2;
    rfb._trackpadFbY = rfb._display.height / 2;
  }
  moveTrackpadPointer(rfb, rfb._trackpadFbX, rfb._trackpadFbY);

  const canvas = rfb._canvas;
  const TAP = 10;
  const LONG = 500;
  let lastX = 0;
  let lastY = 0;
  let active = false;
  let moved = false;
  let longTimer = null;

  const onStart = (e) => {
    if (rfb.viewOnly || e.touches.length !== 1) {
      return;
    }
    e.preventDefault();
    active = true;
    moved = false;
    lastX = e.touches[0].clientX;
    lastY = e.touches[0].clientY;
    longTimer = setTimeout(() => {
      if (active && !moved) {
        const el = fbToElement(rfb, rfb._trackpadFbX, rfb._trackpadFbY);
        rfb._sendMouse(el.x, el.y, 4);
        rfb._sendMouse(el.x, el.y, 0);
        moved = true;
      }
    }, LONG);
  };

  const onMove = (e) => {
    if (!active || rfb.viewOnly || e.touches.length !== 1) {
      return;
    }
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const dx = (e.touches[0].clientX - lastX) * (canvas.width / rect.width);
    const dy = (e.touches[0].clientY - lastY) * (canvas.height / rect.height);
    lastX = e.touches[0].clientX;
    lastY = e.touches[0].clientY;
    if (Math.hypot(dx, dy) > TAP) {
      if (longTimer) {
        clearTimeout(longTimer);
        longTimer = null;
      }
      moved = true;
    }
    if (!moved) {
      return;
    }
    const scale = rfb._display.scale;
    moveTrackpadPointer(rfb, rfb._trackpadFbX + dx / scale, rfb._trackpadFbY + dy / scale);
  };

  const onEnd = () => {
    if (longTimer) {
      clearTimeout(longTimer);
      longTimer = null;
    }
    if (active && !moved && !rfb.viewOnly) {
      const el = fbToElement(rfb, rfb._trackpadFbX, rfb._trackpadFbY);
      rfb._sendMouse(el.x, el.y, 1);
      rfb._sendMouse(el.x, el.y, 0);
    }
    active = false;
  };

  canvas.addEventListener("touchstart", onStart, { passive: false });
  canvas.addEventListener("touchmove", onMove, { passive: false });
  canvas.addEventListener("touchend", onEnd, { passive: false });
  canvas.addEventListener("touchcancel", onEnd, { passive: false });

  trackpadCleanup = () => {
    if (longTimer) {
      clearTimeout(longTimer);
    }
    canvas.removeEventListener("touchstart", onStart);
    canvas.removeEventListener("touchmove", onMove);
    canvas.removeEventListener("touchend", onEnd);
    canvas.removeEventListener("touchcancel", onEnd);
  };
};

window.nanoSetTrackpad = (on) => {
  trackpadWanted = !!on;
  const rfb = window.nanoRfb;
  if (rfb && rfb._rfbConnectionState === "connected") {
    applyTrackpad(rfb, trackpadWanted);
  }
};

window.nanoRecenterPointer = () => {
  const rfb = window.nanoRfb;
  if (!rfb || !trackpadWanted) {
    return;
  }
  moveTrackpadPointer(rfb, rfb._display.width / 2, rfb._display.height / 2);
};

const begin = () => {
  const rfb = new RFB(screen, url, { shared: true });
  window.nanoRfb = rfb;

  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.viewOnly = params.get("viewOnly") !== "0";
  rfb.showDotCursor = true;
  rfb.background = "#111";
  rfb.qualityLevel = 7;
  rfb.compressionLevel = 7;

  if (passed) {
    rfb.addEventListener("credentialsrequired", () => {
      rfb.sendCredentials({ password: passed });
    });
  }

  // A socket that drops before it ever connected was refused by the core, which
  // for this page means the session cookie did not arrive. That is a sign-in
  // problem, so it is reported apart from an ordinary disconnect to stop the
  // phone showing "Connecting" indefinitely.
  let everConnected = false;

  rfb.addEventListener("connect", () => {
    everConnected = true;
    if (trackpadWanted) {
      applyTrackpad(rfb, true);
    }
    post({ kind: "connect" });
  });
  rfb.addEventListener("disconnect", () => post({ kind: everConnected ? "disconnect" : "auth" }));
  rfb.addEventListener("clipboard", (event) => post({ kind: "clipboard", text: event.detail.text }));
  rfb.addEventListener("bell", () => post({ kind: "bell" }));
  rfb.addEventListener("securityfailure", (event) => {
    post({ kind: "error", message: event.detail?.reason ?? "The desktop refused the connection." });
  });
  rfb.addEventListener("credentialsrequired", () => post({ kind: "credentials" }));
  rfb.focus();
};

if (!url) {
  post({ kind: "error", message: "Missing url." });
} else {
  withSession(begin);
}
`;
}

