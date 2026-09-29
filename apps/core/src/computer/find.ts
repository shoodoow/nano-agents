import { accountHome, accountShared, exec } from "../linux/linux.js";

const MAX_HITS = 100;
const FIND_TIMEOUT = 20;

/**
 * Checks a path stays inside the agent's home or /shared.
 * Why: exported so glob/grep share one gate with read/write — traversal and
 * absolute escapes fail the same way everywhere. Pure for tests.
 * Input: account id, profile, absolute path. Output: nothing, or throws.
 */
export function assertInside(accountId: string, profile: string, path: string): void {
  const home = accountHome(accountId, profile);
  const shared = accountShared(accountId);
  const parts = path.split("/");
  const inside = path === home || path.startsWith(`${home}/`) || path === shared || path.startsWith(`${shared}/`);
  if (!path.startsWith("/") || parts.includes("..") || !inside) {
    throw new Error("Path is outside the home and /shared.");
  }
}

/**
 * Lists files matching a glob under the agent's home or /shared.
 * Why: opencode's glob pattern — structured file discovery beats `find`
 * one-liners the model half-remembers. find -path with a capped head keeps
 * giant trees (node_modules) from flooding the prompt.
 * Input: account, profile, glob like star-star/.ts, optional root dir. Output: paths (<=100).
 */
export async function globFiles(accountId: string, profile: string, pattern: string, root?: string): Promise<string[]> {
  const clean = pattern.trim().slice(0, 200);
  if (!clean || clean.includes("'") || clean.includes("..")) {
    throw new Error("A safe glob pattern is required (no quotes or ..).");
  }
  const base = root?.trim() || accountHome(accountId, profile);
  assertInside(accountId, profile, base);
  const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  const result = await exec(
    accountId,
    ["sh", "-c", `timeout ${FIND_TIMEOUT} find ${quoted(base)} -path ${quoted(`*/${clean.replace(/^\//, "")}`)} 2>/dev/null | head -n ${MAX_HITS}`],
    profile,
  );
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Searches file contents for a regex, capped and binary-safe.
 * Why: opencode's grep pattern — filename:line hits with a snippet each,
 * timeout-guarded and binary-skipped so a huge tree cannot stall the turn.
 * Input: account, profile, regex, optional dir + glob filter. Output: hits (<=100).
 */
export async function grepFiles(
  accountId: string,
  profile: string,
  pattern: string,
  input: { path?: string; include?: string } = {},
): Promise<{ file: string; line: number; text: string }[]> {
  const clean = pattern.trim().slice(0, 200);
  if (!clean) throw new Error("A search pattern is required.");
  const base = input.path?.trim() || accountHome(accountId, profile);
  assertInside(accountId, profile, base);
  if (input.include && (input.include.includes("'") || input.include.includes(".."))) {
    throw new Error("The include filter is unsafe.");
  }
  const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  const include = input.include?.trim() ? `--include=${quoted(input.include.trim())}` : "";
  const result = await exec(
    accountId,
    ["sh", "-c", `timeout ${FIND_TIMEOUT} grep -rnI -E ${quoted(clean)} ${include} ${quoted(base)} 2>/dev/null | head -n ${MAX_HITS}`],
    profile,
  );
  const out: { file: string; line: number; text: string }[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!match) continue;
    out.push({ file: match[1]!, line: Number(match[2]), text: match[3]!.slice(0, 300) });
  }
  return out;
}
