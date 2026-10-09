import { readFile } from "../computer/computer.js";
import { accountHome, exec } from "../linux/linux.js";
import { parseSkillFrontmatter, type SkillSummary } from "./skills.js";

/** Canonical path used by `npx skills add -g` for universal agents. */
const LOCAL_SKILLS_SEGMENT = ".agents/skills";
const MAX_LOCAL_SKILLS = 100;

/**
 * Absolute skills directory inside one agent's Linux home.
 * Input: account id and Linux username. Output: `/home/<profile>/.agents/skills`.
 */
export function agentLocalSkillsRoot(accountId: string, profile: string): string {
  assertSafeProfile(profile);
  return `${accountHome(accountId, profile)}/${LOCAL_SKILLS_SEGMENT}`;
}

/**
 * Lists skills installed in this agent's container home.
 * Why: installs stay on the box (`npx skills add -g`); core never writes them
 * onto the host skills tree. A missing container or empty folder is an empty list.
 */
export async function localSkillCatalog(accountId: string, profile: string): Promise<SkillSummary[]> {
  const paths = await listLocalSkillPaths(accountId, profile);
  const byName = new Map<string, SkillSummary>();
  for (const path of paths) {
    try {
      const parsed = parseSkillFrontmatter(await readFile(accountId, profile, path));
      byName.set(parsed.name, { name: parsed.name, description: parsed.description });
    } catch {
      // Skip broken SKILL.md files so one bad install cannot hide the rest.
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Loads one container-local skill body by frontmatter name.
 * Output: markdown body, or null when this profile has no matching skill.
 */
export async function readLocalSkill(accountId: string, profile: string, name: string): Promise<string | null> {
  assertSafeProfile(profile);
  const direct = `${agentLocalSkillsRoot(accountId, profile)}/${name}/SKILL.md`;
  try {
    const parsed = parseSkillFrontmatter(await readFile(accountId, profile, direct));
    if (parsed.name === name) return withSkillDirectory(direct, parsed.body);
  } catch {
    // Fall through to a scan — folder name may differ from frontmatter name.
  }
  for (const path of await listLocalSkillPaths(accountId, profile)) {
    try {
      const parsed = parseSkillFrontmatter(await readFile(accountId, profile, path));
      if (parsed.name === name) return withSkillDirectory(path, parsed.body);
    } catch {
      // Skip unreadable entries.
    }
  }
  return null;
}

/**
 * Tells the reader where an installed skill lives on the computer.
 * Why: skill bodies link to sibling files with relative paths; without the
 * directory the model guesses an absolute path and the read fails.
 */
function withSkillDirectory(skillFile: string, body: string): string {
  const directory = skillFile.replace(/\/[^/]+$/, "");
  return `Skill directory: ${directory} (relative links in this skill resolve from here; sibling skills sit next to it)\n\n${body}`;
}

async function listLocalSkillPaths(accountId: string, profile: string): Promise<string[]> {
  assertSafeProfile(profile);
  const root = agentLocalSkillsRoot(accountId, profile);
  const quoted = shellQuote(root);
  try {
    const result = await exec(
      accountId,
      [
        "bash",
        "-lc",
        `if [ -d ${quoted} ]; then find ${quoted} -mindepth 2 -maxdepth 2 -type f -name SKILL.md 2>/dev/null | head -n ${MAX_LOCAL_SKILLS}; fi`,
      ],
      profile,
    );
    if (result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function assertSafeProfile(profile: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) {
    throw new Error("Linux profile is invalid.");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
