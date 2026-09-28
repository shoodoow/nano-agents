import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";
import { exec, execBytes } from "../linux/linux.js";

type Session = { display: number; rfbPort: number; novncPort: number };

const sessions = new Map<string, Session>();
const held = new Set<string>();
let nextDisplay = 1;

/**
 * Starts this profile's virtual display, VNC, and noVNC inside the account Linux.
 * Input: the account id and the Linux username.
 * Output: the display number and the noVNC port bound on 127.0.0.1 inside the container.
 */
export async function startDesktop(accountId: string, profile: string): Promise<Session> {
  const existing = sessions.get(key(accountId, profile));
  if (existing) {
    return existing;
  }
  const display = nextDisplay++;
  const session = { display, rfbPort: 5900 + display, novncPort: 6900 + display };
  const ready = await exec(accountId, [
    "bash",
    "-lc",
    [
      `nohup Xvfb :${display} -screen 0 320x240x24 -ac >/tmp/xvfb-${display}.log 2>&1 &`,
      `for i in $(seq 1 50); do xset -display :${display} q >/dev/null 2>&1 && break; sleep 0.1; done`,
      `xset -display :${display} q >/dev/null`,
      `nohup x11vnc -display :${display} -localhost -nopw -rfbport ${session.rfbPort} -forever -shared >/tmp/vnc-${display}.log 2>&1 &`,
      `nohup websockify 127.0.0.1:${session.novncPort} 127.0.0.1:${session.rfbPort} >/tmp/novnc-${display}.log 2>&1 &`,
      `for i in $(seq 1 50); do nc -z 127.0.0.1 ${session.novncPort} && exit 0; sleep 0.1; done`,
      `cat /tmp/xvfb-${display}.log /tmp/vnc-${display}.log /tmp/novnc-${display}.log`,
      "exit 1",
    ].join("\n"),
  ]);
  if (ready.code !== 0) {
    throw new Error(ready.stdout || "The desktop did not start.");
  }
  sessions.set(key(accountId, profile), session);
  return session;
}

/**
 * Captures the profile's display and paints the pointer into the picture.
 * Input: the account id and the Linux username.
 * Output: a PPM image. Two pointer positions produce different bytes.
 */
export async function screenshot(accountId: string, profile: string): Promise<Buffer> {
  const session = await startDesktop(accountId, profile);
  const shot = await execBytes(accountId, ["import", "-window", "root", "ppm:-"], profile, displayEnv(session));
  if (shot.code !== 0) {
    throw new Error(shot.stdout.toString("utf8") || "The screenshot failed.");
  }
  const where = await exec(accountId, ["xdotool", "getmouselocation", "--shell"], profile, displayEnv(session));
  const x = Number(/X=(\d+)/.exec(where.stdout)?.[1] ?? "0");
  const y = Number(/Y=(\d+)/.exec(where.stdout)?.[1] ?? "0");
  return stamp(shot.stdout, x, y);
}

/**
 * Moves the pointer on the profile's display.
 * Input: the account id, the Linux username, and pixel coordinates.
 * Output: nothing. The pointer is at that point unless a person has taken over.
 */
export async function mouse(accountId: string, profile: string, x: number, y: number): Promise<void> {
  assertAgent(accountId, profile);
  const session = await startDesktop(accountId, profile);
  const moved = await exec(
    accountId,
    ["xdotool", "mousemove", "--sync", String(x), String(y)],
    profile,
    displayEnv(session),
  );
  if (moved.code !== 0) {
    throw new Error(moved.stdout || "The pointer did not move.");
  }
}

/**
 * Types text on the profile's display.
 * Input: the account id, the Linux username, and the text.
 * Output: nothing. The keystrokes were sent unless a person has taken over.
 */
export async function keyboard(accountId: string, profile: string, text: string): Promise<void> {
  assertAgent(accountId, profile);
  const session = await startDesktop(accountId, profile);
  const typed = await exec(accountId, ["xdotool", "type", "--delay", "0", "--", text], profile, displayEnv(session));
  if (typed.code !== 0) {
    throw new Error(typed.stdout || "The keys were not sent.");
  }
}

/**
 * Gives the person the pointer and keyboard.
 * Input: the account id and the Linux username.
 * Output: nothing. Agent mouse and keyboard calls pause until hand-back.
 */
export function takeOver(accountId: string, profile: string): void {
  held.add(key(accountId, profile));
}

/**
 * Returns the pointer and keyboard to the agent.
 * Input: the account id and the Linux username.
 * Output: nothing. Agent mouse and keyboard calls work again.
 */
export function handBack(accountId: string, profile: string): void {
  held.delete(key(accountId, profile));
}

/**
 * Checks that this Linux user belongs to the account.
 * Input: the database, the account id, and the Linux username.
 * Output: true when an agent on that account has this profile.
 */
export async function profileOnAccount(
  db: ReturnType<typeof getDb>,
  accountId: string,
  profile: string,
): Promise<boolean> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.accountId, accountId), eq(agents.linuxProfile, profile)));
  return Boolean(agent);
}

/**
 * Returns the noVNC port for a running profile.
 * Input: the account id and the Linux username.
 * Output: the port on 127.0.0.1 inside the container, or null when the desktop is not started.
 */
export function novncPort(accountId: string, profile: string): number | null {
  return sessions.get(key(accountId, profile))?.novncPort ?? null;
}

function assertAgent(accountId: string, profile: string): void {
  if (held.has(key(accountId, profile))) {
    throw new Error("The person has the pointer.");
  }
}

function key(accountId: string, profile: string): string {
  return `${accountId}:${profile}`;
}

function displayEnv(session: Session): string[] {
  return [`DISPLAY=:${session.display}`];
}

function stamp(ppm: Buffer, x: number, y: number): Buffer {
  let index = 0;
  const tokens: string[] = [];
  while (tokens.length < 4 && index < ppm.length) {
    while (index < ppm.length && (ppm[index] === 32 || ppm[index] === 10 || ppm[index] === 13 || ppm[index] === 9)) {
      index += 1;
    }
    if (ppm[index] === 35) {
      while (index < ppm.length && ppm[index] !== 10) {
        index += 1;
      }
      continue;
    }
    const start = index;
    while (
      index < ppm.length &&
      ppm[index] !== 32 &&
      ppm[index] !== 10 &&
      ppm[index] !== 13 &&
      ppm[index] !== 9
    ) {
      index += 1;
    }
    tokens.push(ppm.subarray(start, index).toString("ascii"));
  }
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  const offset = index + 1;
  const copy = Buffer.from(ppm);
  const px = Math.max(0, Math.min(width - 1, x));
  const py = Math.max(0, Math.min(height - 1, y));
  const at = offset + (py * width + px) * 3;
  copy[at] = 255;
  copy[at + 1] = 0;
  copy[at + 2] = 0;
  return copy;
}
