import { describe, expect, it } from "vitest";
import { linuxToolNames } from "../rooms/turn.js";
import { assertShellSafe } from "./computer.js";

/**
 * Locks the two computer-use fixes: the model is offered grounded desktop
 * hands (not just shell), and bash can never hijack the display server.
 */
describe("computer-use wiring", () => {
  it("offers file, shell, and grounded desktop tools together", () => {
    expect(linuxToolNames()).toEqual([
      "bash",
      "computer_click",
      "computer_key",
      "computer_mouse",
      "computer_screenshot",
      "computer_type",
      "read",
      "write",
    ]);
  });

  it("rejects display-server hijacking but allows normal GUI apps", () => {
    expect(() => assertShellSafe("chromium --no-sandbox https://example.com")).not.toThrow();
    expect(() => assertShellSafe("xterm &")).not.toThrow();
    expect(() => assertShellSafe("Xvfb :1 -screen 0 1280x800x24 &")).toThrow(/display server/i);
    expect(() => assertShellSafe("x11vnc -display :42 -rfbport 5900 &")).toThrow(/display server/i);
    expect(() => assertShellSafe("DISPLAY=:1 chromium")).toThrow(/display server/i);
    expect(() => assertShellSafe("websockify 127.0.0.1:6080 127.0.0.1:5900 &")).toThrow(/display server/i);
  });
});
