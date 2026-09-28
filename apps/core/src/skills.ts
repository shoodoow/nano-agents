import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SkillSummary = { name: string; description: string };

/**
 * Lists the skills in one directory.
 * Input: a directory whose children are Agent Skills folders.
 * Output: each skill's name and description, sorted by name. The body is not included.
 */
export function skillCatalog(directory: string): SkillSummary[] {
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
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
    .filter((entry) => entry.isDirectory())
    .map((entry) => readFrontmatter(readFileSync(join(directory, entry.name, "SKILL.md"), "utf8")))
    .find((skill) => skill.name === name);
  if (!match) {
    throw new Error(`Skill ${name} is missing.`);
  }
  return match.body;
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
