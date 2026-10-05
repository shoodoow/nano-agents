import {
  agentDisplay,
  assertControllable,
  click,
  keyboard,
  mouse,
  pressKey,
  resolveSession,
  screenshotPng,
  clampPoint,
  DESKTOP_WIDTH,
  DESKTOP_HEIGHT,
} from "../desktop/desktop.js";
import { accountShared, exec, execStdin } from "../linux/linux.js";
import { assertInside } from "./find.js";

// Why: the agent must work on its assigned desktop — the one the viewer shows
// — never boot a private X server on another display (the blank-viewer
// bug). These patterns catch Xvfb/x11vnc/websockify startups and raw DISPLAY
// overrides smuggled inside bash commands.
const FORBIDDEN_DISPLAY = [
  /\bxvfb\b/i,
  /\bx11vnc\b/i,
  /\bwebsockify\b/i,
  /\bX\s*:[0-9]+\b/,
  /\bDISPLAY\s*=/,
  /\bxrandr\b.*\b--output\b/i,
];

/**
 * Checks a shell command for display-server hijacking.
 * Why: pure and exported for unit tests; rejects private X servers, VNC
 * servers, and DISPLAY overrides so the agent cannot orphan its assigned
 * desktop. Legit GUI apps (chromium, xterm) pass through untouched.
 * Input: the command text. Output: nothing, or throws naming the rule.
 */
export function assertShellSafe(command: string): void {
  for (const pattern of FORBIDDEN_DISPLAY) {
    if (pattern.test(command)) {
      throw new Error(
        "That command touches the display server. Use your assigned desktop (DISPLAY is already set) and the computer tools — do not start Xvfb, x11vnc, or override DISPLAY.",
      );
    }
  }
}

/**
 * Reads a file as the agent.
 * Input: the account id, the Linux username, and an absolute path inside that home or /shared.
 * Output: the file text.
 */
export async function readFile(accountId: string, profile: string, path: string): Promise<string> {
  assertPath(accountId, path, profile);
  const result = await exec(accountId, ["cat", path], profile);
  if (result.code !== 0) {
    throw new Error(result.stdout || "The file could not be read.");
  }
  return result.stdout;
}

/**
 * Writes a file as the agent.
 * Input: the account id, the Linux username, an absolute path, and the text.
 * Output: nothing. The file is created or replaced.
 */
export async function writeFile(accountId: string, profile: string, path: string, body: string): Promise<void> {
  assertPath(accountId, path, profile);
  const encoded = Buffer.from(body).toString("base64");
  const result = await exec(accountId, ["bash", "-lc", `printf %s '${encoded}' | base64 -d > '${path}'`], profile);
  if (result.code !== 0) {
    throw new Error(result.stdout || "The file could not be written.");
  }
}

/**
 * Runs a shell command as the agent on its assigned desktop.
 * Why: DISPLAY resolves from the same deterministic function the viewer uses,
 * so chromium/xterm always open on the watched screen. Display-server
 * commands are rejected (see assertShellSafe) to prevent viewer mismatch.
 * Input: the account id, the Linux username, and the command text.
 * Output: the command's text.
 */
export async function bash(accountId: string, profile: string, command: string): Promise<string> {
  assertShellSafe(command);
  const display = agentDisplay(accountId, profile) ?? (await resolveSession(accountId, profile)).display;
  const displayName = typeof display === "string" ? display : `:${display}`;
  const result = await exec(accountId, ["bash", "-lc", command], profile, [`DISPLAY=${displayName}`]);
  if (result.code !== 0) {
    throw new Error(result.stdout || "The command failed.");
  }
  return result.stdout;
}

/**
 * Takes a grounded PNG screenshot of the agent's own display.
 * Why: thin wrapper so model tools share one path with the same takeover
 * guard and per-screen serialization as mouse/keyboard. Bytes are written to
 * a path the parent can cite; pngBase64 is only for the worker's vision step
 * via toModelOutput (never echoed into the parent report).
 * Input: account id + profile. Output: {path, display, width, height, pngBase64}.
 */
export async function screenshotImage(accountId: string, profile: string) {
  assertControllable(accountId, profile);
  const shot = await screenshotPng(accountId, profile);
  const dir = `${accountShared(accountId)}/screenshots/${profile}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${dir}/shot-${stamp}.png`;
  const mkdir = await exec(accountId, ["bash", "-lc", `mkdir -p '${dir}'`], profile);
  if (mkdir.code !== 0) {
    throw new Error(mkdir.stdout || "Could not create screenshots directory.");
  }
  const written = await execStdin(
    accountId,
    ["bash", "-lc", `cat > '${path}'`],
    Buffer.from(shot.pngBase64, "base64"),
    profile,
  );
  if (written.code !== 0) {
    throw new Error(written.stdout.toString("utf8").slice(0, 500) || "Could not save screenshot.");
  }
  return {
    path,
    display: shot.display,
    width: shot.width,
    height: shot.height,
    pngBase64: shot.pngBase64,
  };
}

/**
 * Moves the pointer to clamped coordinates on the agent's display.
 * Why: clamping absorbs model coordinate hallucination; guard + lock shared
 * with click/type. Input: account id, profile, x/y. Output: clamped {x, y}.
 */
export async function moveMouse(accountId: string, profile: string, x: number, y: number) {
  assertControllable(accountId, profile);
  return mouse(accountId, profile, x, y);
}

/**
 * Atomically moves and left-clicks so grounding cannot race a screenshot.
 * Input: account id, profile, x/y, optional button. Output: clamped {x, y}.
 */
export async function clickAt(accountId: string, profile: string, x: number, y: number, button = 1) {
  assertControllable(accountId, profile);
  return click(accountId, profile, x, y, button);
}

/**
 * Types text on the agent's display (1-4000 chars per call).
 * Input: account id, profile, text. Output: {typed} character count.
 */
export async function typeText(accountId: string, profile: string, text: string) {
  assertControllable(accountId, profile);
  return keyboard(accountId, profile, text);
}

/**
 * Presses one allowlisted key combo on the agent's display.
 * Input: account id, profile, combo (Return, Escape, ctrl+c...). Output: {key}.
 */
export async function pressKeys(accountId: string, profile: string, combo: string) {
  assertControllable(accountId, profile);
  return pressKey(accountId, profile, combo);
}

function assertPath(accountId: string, path: string, profile: string): void {
  // Single gate lives in find.ts — one definition, no drift between tools.
  assertInside(accountId, profile, path);
}

export { clampPoint, DESKTOP_WIDTH, DESKTOP_HEIGHT };
