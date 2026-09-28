import { agentDisplay, startDesktop } from "../desktop/desktop.js";
import { accountHome, accountShared, exec } from "../linux/linux.js";

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
 * Runs a shell command as the agent.
 * Input: the account id, the Linux username, and the command text.
 * Output: the command's text.
 */
export async function bash(accountId: string, profile: string, command: string): Promise<string> {
  const display = agentDisplay(accountId, profile) ?? `:${(await startDesktop(accountId, profile)).display}`;
  const result = await exec(accountId, ["bash", "-lc", command], profile, [`DISPLAY=${display}`]);
  if (result.code !== 0) {
    throw new Error(result.stdout || "The command failed.");
  }
  return result.stdout;
}

function assertPath(accountId: string, path: string, profile: string): void {
  const home = accountHome(accountId, profile);
  const shared = accountShared(accountId);
  const parts = path.split("/");
  const inside = path === home || path.startsWith(`${home}/`) || path === shared || path.startsWith(`${shared}/`);
  if (!path.startsWith("/") || parts.includes("..") || !inside) {
    throw new Error("Path is outside the home and /shared.");
  }
}
