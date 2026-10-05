import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { novncRoot, novncShell, novncShellScript } from "./novnc.js";

/**
 * Locks the viewer page contract. The phone loads this document into a WebView
 * and the shell opens the socket, so both the URL shape and the module imports
 * are load-bearing: a wrong asset prefix fails only on a device.
 */
describe("novnc viewer page", () => {
  it("resolves the installed client library", () => {
    const root = novncRoot();
    expect(root).not.toBeNull();
    expect(existsSync(join(root ?? "", "core", "rfb.js"))).toBe(true);
    expect(existsSync(join(root ?? "", "vendor", "pako", "lib", "zlib", "inflate.js"))).toBe(true);
  });

  it("imports RFB as a default export from the served asset path", () => {
    const script = novncShellScript("/assets/novnc");
    expect(script).toContain('import RFB from "/assets/novnc/core/rfb.js"');
    expect(script).not.toContain("import { RFB }");
  });

  it("loads the driver as a module file so a strict CSP can run it", () => {
    const shell = novncShell("/assets/novnc");
    expect(shell).toContain('<script type="module" src="/assets/novnc/shell.js"></script>');
    expect(shell).not.toContain("<script type=\"module\">");
  });

  it("reads the socket endpoint from the url parameter", () => {
    const script = novncShellScript("/assets/novnc");
    expect(script).toContain('params.get("url")');
    expect(script).toContain("new RFB(screen, url");
  });

  it("reports state back to the phone and tolerates a missing bridge", () => {
    const script = novncShellScript("/assets/novnc");
    expect(script).toContain("window.ReactNativeWebView.postMessage");
    expect(script).toContain("window.nanoRfb = rfb");
    for (const kind of ["connect", "disconnect", "clipboard", "securityfailure", "credentialsrequired"]) {
      expect(script).toContain(`"${kind}"`);
    }
  });

  it("normalizes a trailing slash in the asset prefix", () => {
    expect(novncShellScript("/assets/novnc/")).toContain('import RFB from "/assets/novnc/core/rfb.js"');
    expect(novncShell("/assets/novnc/")).toContain('src="/assets/novnc/shell.js"');
  });

  it("supports optional trackpad mode and runtime pointer controls", () => {
    const script = novncShellScript("/assets/novnc");
    expect(script).toContain('params.get("trackpad") === "1"');
    expect(script).toContain("window.nanoSetTrackpad");
    expect(script).toContain("window.nanoRecenterPointer");
    expect(script).toContain("rfb.showDotCursor = true");
  });

  it("separates a refused socket from an ordinary disconnect", () => {
    const script = novncShellScript("/assets/novnc");
    // A socket that never connected means the core rejected the page's cookie,
    // which the phone must report instead of showing "Connecting" forever.
    expect(script).toContain('kind: everConnected ? "disconnect" : "auth"');
    // The phone needs a way to see whether the viewer is merely mirroring.
    expect(script).toContain("rfb.viewOnly = params.get(\"viewOnly\") !== \"0\"");
  });

  it("waits for the phone to plant the session before connecting", () => {
    const script = novncShellScript("/assets/novnc");
    // Constructing RFB before the cookie exists loses the race on iOS, where
    // scripts injected before content load run before the origin is committed.
    expect(script).toContain("window.__nanoSessionReady");
    expect(script).toContain("window.__nanoNoSession");
    expect(script).toContain("withSession(begin)");
    // The wait has to end, or a phone that never signs in hangs forever.
    expect(script).toContain("Date.now() > deadline");
    expect(script).toMatch(/clearInterval/);
    // The socket must only be created inside the deferred start path.
    const connect = script.indexOf("withSession(begin)");
    const construct = script.indexOf("new RFB(");
    expect(construct).toBeLessThan(connect);
  });
});
