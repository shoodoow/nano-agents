import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Account installs live one level down so skillCatalog(root) never treats
// them as shared skills. The folder name is fixed and is not a skill.
const ACCOUNT_SKILLS = "accounts";

export type SkillSummary = { name: string; description: string };

/**
 * Lists the skills in one directory.
 * Input: a directory whose children are Agent Skills folders.
 * Output: each skill's name and description, sorted by name. The body is not included.
 */
export function skillCatalog(directory: string): SkillSummary[] {
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ACCOUNT_SKILLS)
    .map((entry) => join(directory, entry.name, "SKILL.md"))
    .filter((path) => existsSync(path));
  return names
    .map((path) => readFrontmatter(readFileSync(path, "utf8")))
    .map((skill) => ({ name: skill.name, description: skill.description }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Loads one skill body.
 * Input: the skills directory and the skill name from its frontmatter.
 * Output: the markdown after the frontmatter. A missing name throws.
 */
export function readSkill(directory: string, name: string): string {
  const match = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ACCOUNT_SKILLS)
    .map((entry) => join(directory, entry.name, "SKILL.md"))
    .filter((path) => existsSync(path))
    .map((path) => readFrontmatter(readFileSync(path, "utf8")))
    .find((skill) => skill.name === name);
  if (!match) {
    throw new Error(`Skill ${name} is missing.`);
  }
  return match.body;
}

/**
 * Directory where one account's approved skills are written.
 * Why: a shared skills root would publish one account's lesson to every
 * tenant. The id is a uuid from our database, so the path cannot escape.
 * Input: skills root and account id. Output: absolute directory path.
 */
export function accountSkillRoot(root: string, accountId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
    throw new Error("Account id is not a uuid.");
  }
  return join(root, ACCOUNT_SKILLS, accountId);
}

/**
 * Lists skills visible to one account.
 * Why: shared folders ship with the install. An account folder overrides a
 * shared skill of the same name and can add its own. The body stays out.
 * Input: skills root and account id. Output: name and description, sorted.
 */
export function skillCatalogForAccount(root: string, accountId: string): SkillSummary[] {
  const ownRoot = accountSkillRoot(root, accountId);
  const own = existsSync(ownRoot) ? skillCatalog(ownRoot) : [];
  const byName = new Map(skillCatalog(root).map((skill) => [skill.name, skill]));
  for (const skill of own) byName.set(skill.name, skill);
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Loads one skill body for one account.
 * Why: the catalog shows the override, so the body must be the override too.
 * A missing account copy falls through to the shared skill.
 * Input: skills root, account id, skill name. Output: markdown body.
 */
export function readSkillForAccount(root: string, accountId: string, name: string): string {
  const ownRoot = accountSkillRoot(root, accountId);
  if (existsSync(ownRoot)) {
    try {
      return readSkill(ownRoot, name);
    } catch (error) {
      if (!(error instanceof Error) || !/missing/.test(error.message)) throw error;
    }
  }
  return readSkill(root, name);
}

function readFrontmatter(text: string): { name: string; description: string; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("SKILL.md is missing frontmatter.");
  }
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields.set(key, value);
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) {
    throw new Error("SKILL.md needs a name and a description.");
  }
  return { name, description, body: (match[2] ?? "").trim() };
}
