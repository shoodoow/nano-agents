import { and, eq } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";
import { exec, execBytes } from "../linux/linux.js";

type Session = { display: number; rfbPort: number; novncPort: number };

export const DESKTOP_WIDTH = 1280;
export const DESKTOP_HEIGHT = 800;

const sessions = new Map<string, Session>();
const held = new Set<string>();
// One computer-use task per screen at a time (Grok parity): bots run in
// parallel across profiles, but serialize on their own display so mouse +
// screenshot + type sequences never interleave.
const computerLocks = new Map<string, Promise<void>>();

/**
 * Derives the deterministic X display for a Linux profile.
 * Why: the old incrementing counter reset on process restart, so a restarted
 * core assigned a fresh :N while the container still ran Xvfb on the old one.
 * The bot then screenshotted one display while the viewer proxied another —
 * the classic blank-viewer mismatch. Hashing the username makes the agent
 * display, the viewer display, and every restart agree by construction.
 * Input: the Linux username (e.g. uabc123). Output: display 10-79.
 */
export function displayFor(profile: string): number {
  let hash = 2166136261;
  for (let i = 0; i < profile.length; i += 1) {
    hash ^= profile.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 10 + (Math.abs(hash) % 70);
}

/**
 * Returns the display name for a profile without any I/O.
 * Why: bash, screenshot, and the noVNC proxy must all resolve the same :N
 * even before the desktop has started. Pure function of the username.
 * Input: the Linux username. Output: e.g. ":42".
 */
export function displayName(profile: string): string {
  return `:${displayFor(profile)}`;
}

/**
 * Returns the RFB/noVNC ports for a profile without any I/O.
 * Why: ports derive from the display, so viewer and agent can never disagree.
 * Input: the Linux username. Output: {rfbPort, novncPort} on 127.0.0.1.
 */
export function portsFor(profile: string): { rfbPort: number; novncPort: number } {
  const display = displayFor(profile);
  return { rfbPort: 5900 + display, novncPort: 6900 + display };
}

/**
 * Starts this profile's virtual display, VNC, and noVNC inside the account Linux.
 * Why: idempotent and deterministic — the display/ports come from displayFor()
 * so restarts reconcile to the same :N instead of allocating a new one. The
 * fast path only probes (xset + novnc port) with zero side effects, because
 * re-running the full setup would warp the pointer back to center and restart
 * VNC under the viewer on every screenshot. Full setup runs solely when the
 * probe fails (fresh desktop or dead server).
 * Input: the account id and the Linux username.
 * Output: the display number and the noVNC port bound on 127.0.0.1 inside the container.
 */
export async function startDesktop(accountId: string, profile: string): Promise<Session> {
  const display = displayFor(profile);
  const { rfbPort, novncPort } = portsFor(profile);
  const session = { display, rfbPort, novncPort };
  // Fast reconcile: X alive and noVNC listening means viewer, agent tools, and
  // bash DISPLAY already agree — return without touching pointer or servers.
  const probe = await exec(accountId, [
    "sh",
    "-c",
    `xset -display :${display} q >/dev/null 2>&1 && nc -z 127.0.0.1 ${novncPort}`,
  ]);
  if (probe.code === 0) {
    sessions.set(key(accountId, profile), session);
    return session;
  }
  const ready = await exec(accountId, [
    "bash",
    "-lc",
    [
      `if ! xset -display :${display} q >/dev/null 2>&1; then`,
      `  if [ -f /tmp/.X${display}-lock ]; then kill $(tr -cd 0-9 < /tmp/.X${display}-lock) || true; sleep 0.4; fi`,
      `  rm -f /tmp/.X${display}-lock /tmp/.X11-unix/X${display}`,
      `  nohup Xvfb :${display} -screen 0 ${DESKTOP_WIDTH}x${DESKTOP_HEIGHT}x24 -ac >/tmp/xvfb-${display}.log 2>&1 &`,
      `  for i in $(seq 1 50); do xset -display :${display} q >/dev/null 2>&1 && break; sleep 0.1; done`,
      `  xset -display :${display} q >/dev/null`,
      `fi`,
      `mkdir -p /tmp/desktop-${display}`,
      `convert -size 1280x800 gradient:'#3a3a3a-#121212' -fill '#d0d0d0' -draw 'ellipse 640,820 420,280 0,360' /tmp/desktop-${display}/wallpaper.png`,
      `convert -size 48x48 xc:'#3c4043' -fill '#8ab4f8' -draw 'circle 24,24 24,8' /tmp/desktop-${display}/chrome.png`,
      `convert -size 48x48 xc:'#3c4043' -fill '#e8eaed' -draw 'rectangle 10,16 38,36' /tmp/desktop-${display}/files.png`,
      `convert -size 48x48 xc:'#202124' -fill '#e8eaed' -draw 'rectangle 12,22 20,26' -draw 'rectangle 24,22 36,26' /tmp/desktop-${display}/bash.png`,
      `cat > /tmp/desktop-${display}/jwmrc << 'EOF'\n${jwmConfig(display)}\nEOF`,
      `xsetroot -display :${display} -solid '#1a1a1a' || true`,
      `xsetroot -display :${display} -cursor_name left_ptr || true`,
      `timeout 3 display -window root /tmp/desktop-${display}/wallpaper.png >/tmp/desktop-${display}/wall.log 2>&1 || true`,
      `echo ${Buffer.from(serveDesktop(display, session.rfbPort, session.novncPort)).toString("base64")} | base64 -d > /tmp/desktop-${display}/serve.sh`,
      `sh /tmp/desktop-${display}/serve.sh`,
      `nohup bash -lc ${shellQuote(bootDesktop(display, profile))} >/tmp/desktop-${display}/boot.log 2>&1 &`,
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
 * Resolves the single source of truth session for a profile.
 * Why: every consumer — agent tools, bash DISPLAY, screenshot, and the noVNC
 * proxy — must agree on the same :N and ports. Deterministic derivation means
 * no allocation state to lose on restart; startDesktop reconciles the server.
 * Input: account id + profile. Output: session (starts the desktop if needed).
 */
export async function resolveSession(accountId: string, profile: string): Promise<Session> {
  return startDesktop(accountId, profile);
}

/**
 * Throws when the person currently holds the pointer/keyboard.
 * Why: exported so computer tools and model tool wrappers share one guard;
 * the agent must never fight the user for input. Takeover pauses the agent.
 * Input: account id + profile. Output: nothing, or throws "person has the pointer".
 */
export function assertControllable(accountId: string, profile: string): void {
  assertAgent(accountId, profile);
}

/**
 * Serializes computer-use tasks on one screen.
 * Why: Grok parity — one bot runs one computer-use task on its screen at a
 * time, while different bots (profiles) proceed in parallel. Queuing per key
 * keeps mouse→screenshot→type sequences atomic without a global lock.
 * Input: account id, profile, and the async work. Output: the work's result.
 */
export async function withComputerUse<T>(accountId: string, profile: string, work: () => Promise<T>): Promise<T> {
  const lockKey = key(accountId, profile);
  const previous = computerLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  computerLocks.set(lockKey, previous.then(() => current));
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (computerLocks.get(lockKey) === current) computerLocks.delete(lockKey);
  }
}

/**
 * Clamps pixel coordinates to the desktop geometry.
 * Why: models hallucinate out-of-range or fractional coordinates; clamping
 * keeps xdotool from erroring and makes grounding robust. Pure for testing.
 * Input: x/y numbers. Output: integer {x, y} inside 0..WIDTH-1 / 0..HEIGHT-1.
 */
export function clampPoint(x: number, y: number): { x: number; y: number } {
  const cx = Number.isFinite(x) ? Math.round(x) : 0;
  const cy = Number.isFinite(y) ? Math.round(y) : 0;
  return {
    x: Math.max(0, Math.min(DESKTOP_WIDTH - 1, cx)),
    y: Math.max(0, Math.min(DESKTOP_HEIGHT - 1, cy)),
  };
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
 * Captures a PNG screenshot sized for model input.
 * Why: PPM is unbounded and unreadable to vision models; PNG base64 is what
 * grounded computer-use needs. Runs serialized per screen for consistency.
 * Input: account id + profile. Output: {display, width, height, pngBase64}.
 */
export async function screenshotPng(
  accountId: string,
  profile: string,
): Promise<{ display: string; width: number; height: number; pngBase64: string }> {
  return withComputerUse(accountId, profile, async () => {
    assertAgent(accountId, profile);
    const session = await startDesktop(accountId, profile);
    const shot = await execBytes(
      accountId,
      ["import", "-window", "root", `png:-`],
      profile,
      displayEnv(session),
    );
    if (shot.code !== 0 || shot.stdout.length === 0) {
      throw new Error(shot.stdout.toString("utf8").slice(0, 500) || "The screenshot failed.");
    }
    if (shot.stdout.length > 2_000_000) {
      throw new Error("The screenshot is too large; move the pointer and try a smaller region.");
    }
    return {
      display: `:${session.display}`,
      width: DESKTOP_WIDTH,
      height: DESKTOP_HEIGHT,
      pngBase64: shot.stdout.toString("base64"),
    };
  });
}

/**
 * Moves the pointer on the profile's display.
 * Why: serialized per screen so a move→screenshot grounding pair cannot be
 * split by a concurrent click. Coordinates are clamped to 1280x800.
 * Input: the account id, the Linux username, and pixel coordinates.
 * Output: the clamped {x, y} now holding the pointer.
 */
export async function mouse(accountId: string, profile: string, x: number, y: number): Promise<{ x: number; y: number }> {
  return withComputerUse(accountId, profile, async () => {
    assertAgent(accountId, profile);
    const at = clampPoint(x, y);
    const session = await startDesktop(accountId, profile);
    const moved = await exec(
      accountId,
      ["xdotool", "mousemove", "--sync", String(at.x), String(at.y)],
      profile,
      displayEnv(session),
    );
    if (moved.code !== 0) {
      throw new Error(moved.stdout || "The pointer did not move.");
    }
    return at;
  });
}

/**
 * Clicks at clamped coordinates (move + left click atomically).
 * Why: separate move/click tool calls race with screenshots; one atomic click
 * keeps grounding accurate. Serialized per screen.
 * Input: account id, profile, x/y, button (1=left default). Output: clamped point.
 */
export async function click(
  accountId: string,
  profile: string,
  x: number,
  y: number,
  button = 1,
): Promise<{ x: number; y: number }> {
  return withComputerUse(accountId, profile, async () => {
    assertAgent(accountId, profile);
    const at = clampPoint(x, y);
    const session = await startDesktop(accountId, profile);
    const done = await exec(
      accountId,
      ["xdotool", "mousemove", "--sync", String(at.x), String(at.y), "click", String(button)],
      profile,
      displayEnv(session),
    );
    if (done.code !== 0) {
      throw new Error(done.stdout || "The click failed.");
    }
    return at;
  });
}

/**
 * Types text on the profile's display.
 * Why: capped at 4k chars per call so a runaway model cannot paste megabytes
 * into the desktop; longer text should use write+paste or multiple calls.
 * Input: the account id, the Linux username, and the text.
 * Output: the number of characters sent.
 */
export async function keyboard(accountId: string, profile: string, text: string): Promise<{ typed: number }> {
  return withComputerUse(accountId, profile, async () => {
    assertAgent(accountId, profile);
    if (text.length === 0 || text.length > 4000) {
      throw new Error("Text must be 1-4000 characters.");
    }
    const session = await startDesktop(accountId, profile);
    const typed = await exec(accountId, ["xdotool", "type", "--delay", "0", "--", text], profile, displayEnv(session));
    if (typed.code !== 0) {
      throw new Error(typed.stdout || "The keys were not sent.");
    }
    return { typed: text.length };
  });
}

/**
 * Presses one key combo (e.g. Return, ctrl+c, alt+Tab).
 * Why: typing alone cannot submit forms or switch windows; allowlist keeps
 * the model from sending dangerous combos. Serialized per screen.
 * Input: account id, profile, key string from the allowlist.
 * Output: the key that was sent.
 */
export async function pressKey(accountId: string, profile: string, combo: string): Promise<{ key: string }> {
  const allowed = /^(Return|Escape|Tab|BackSpace|Delete|Up|Down|Left|Right|Home|End|Page_Up|Page_Down|F[0-9]{1,2}|(ctrl|alt|shift)\+[a-zA-Z0-9]+)$/;
  return withComputerUse(accountId, profile, async () => {
    assertAgent(accountId, profile);
    if (!allowed.test(combo) || combo.length > 32) {
      throw new Error("Unsupported key combo. Use Return, Escape, Tab, arrows, F-keys, or ctrl/alt/shift+x.");
    }
    const session = await startDesktop(accountId, profile);
    const done = await exec(accountId, ["xdotool", "key", "--clearmodifiers", combo], profile, displayEnv(session));
    if (done.code !== 0) {
      throw new Error(done.stdout || "The key was not sent.");
    }
    return { key: combo };
  });
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
 * Returns the noVNC port for a profile.
 * Why: deterministic from the display, so the viewer resolves the same port
 * even after a core restart with an empty session cache. Never null — the
 * proxy calls startDesktop first, which guarantees the server is listening.
 * Input: the account id and the Linux username (account unused, kept for symmetry).
 * Output: the port on 127.0.0.1 inside the container.
 */
export function novncPort(_accountId: string, profile: string): number | null {
  return portsFor(profile).novncPort;
}

/**
 * Returns the X display for a profile.
 * Why: deterministic display name — agent tools, bash DISPLAY, screenshots,
 * and the viewer all share this one function, so mismatch is impossible by
 * construction. Never null.
 * Input: the account id and the Linux username (account unused, kept for symmetry).
 * Output: a display name such as ":42".
 */
export function agentDisplay(_accountId: string, profile: string): string | null {
  return displayName(profile);
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function serveDesktop(display: number, rfbPort: number, novncPort: number): string {
  return `#!/bin/sh
if command -v pkill >/dev/null; then
  pkill -f "x11vnc -display :${display}" || true
  pkill -f "websockify 127.0.0.1:${novncPort}" || true
  sleep 0.2
fi
nohup x11vnc -display :${display} -localhost -nopw -cursor arrow -ncache 0 -wait 10 -defer 10 -rfbport ${rfbPort} -forever -shared >/tmp/vnc-${display}.log 2>&1 &
nohup websockify 127.0.0.1:${novncPort} 127.0.0.1:${rfbPort} >/tmp/novnc-${display}.log 2>&1 &
`;
}

function bootDesktop(display: number, profile: string): string {
  const inner = `DISPLAY=:${display} nohup jwm -f /tmp/desktop-${display}/jwmrc >/tmp/jwm-${display}.log 2>&1 & exit 0`;
  return [
    "if ! command -v jwm >/dev/null || ! command -v xterm >/dev/null; then",
    "  for i in 1 2 3 4 5 6 7 8; do",
    "    DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jwm xterm sudo fonts-dejavu-core xfonts-base && break",
    "    sleep 10",
    "  done",
    "fi",
    `printf '%s ALL=(ALL) NOPASSWD:ALL\\n' ${shellQuote(profile)} > /etc/sudoers.d/nano-${profile}`,
    `chmod 440 /etc/sudoers.d/nano-${profile} || true`,
    `su -s /bin/sh ${shellQuote(profile)} -c ${shellQuote(inner)}`,
    "if ! command -v chromium >/dev/null; then DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium pcmanfm || true; fi",
  ].join("\n");
}

function jwmConfig(display: number): string {
  const root = `/tmp/desktop-${display}`;
  const chrome = "chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run --start-maximized";
  return `<JWM>
<WindowStyle>
<Font>DejaVu Sans-11</Font>
<Width>4</Width>
<Height>24</Height>
<Active><Text>#f2f2f2</Text><Title>#2a2a2a</Title></Active>
<Inactive><Text>#bdbdbd</Text><Title>#1a1a1a</Title></Inactive>
</WindowStyle>
<Group>
<Class>Chromium</Class>
<Option>maximized</Option>
</Group>
<Desktops width="1" height="1">
<Desktop><Background type="image">${root}/wallpaper.png</Background></Desktop>
</Desktops>
<Tray x="0" y="728" height="72">
<Spacer/>
<TrayButton label="Chrome" icon="${root}/chrome.png">exec:${chrome}</TrayButton>
<TrayButton label="Files" icon="${root}/files.png">exec:pcmanfm</TrayButton>
<TrayButton label="Bash" icon="${root}/bash.png">exec:xterm</TrayButton>
<Spacer/>
</Tray>
</JWM>`;
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
