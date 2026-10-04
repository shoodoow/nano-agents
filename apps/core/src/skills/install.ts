import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";
import { accountSkillRoot, readSkillForAccount, skillCatalogForAccount } from "./skills.js";

type Database = Pick<ReturnType<typeof getDb>, "update">;

const SOURCE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([A-Za-z0-9_.-]+))?$/;

/**
 * Parses an install spec.
 * Input: owner/repo or owner/repo@skill. Output: the GitHub coordinates.
 */
export function parseSkillSource(source: string): { owner: string; repo: string; skill: string } {
  const match = SOURCE.exec(source.trim());
  if (!match?.[1] || !match[2]) {
    throw new Error("Skill source must look like owner/repo or owner/repo@skill.");
  }
  return { owner: match[1], repo: match[2], skill: match[3] ?? match[2] };
}

function skillName(body: string): string | undefined {
  const lines = body.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") return undefined;
    const match = line.match(/^name:\s*([A-Za-z0-9-]+)\s*$/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * Writes one SKILL.md under this account and checks it loads.
 * Input: skills root, account id, markdown with name frontmatter.
 * Output: the skill name. Another account's folder is not touched.
 */
export function writeAccountSkill(root: string, accountId: string, markdown: string): { name: string } {
  const name = skillName(markdown);
  if (!name) throw new Error("A skill needs a name: field in frontmatter.");
  const directory = join(accountSkillRoot(root, accountId), name);
  mkdirSync(directory, { recursive: true });
  const body = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  writeFileSync(join(directory, "SKILL.md"), body);
  readSkillForAccount(root, accountId, name);
  return { name };
}

export function catalogText(root: string, accountId: string): string {
  return skillCatalogForAccount(root, accountId)
    .map((skill) => `${skill.name}: ${skill.description}`)
    .join("\n");
}

/**
 * Bumps every agent on the account so the cached skill catalog rotates.
 * Input: database and account id. Output: how many agents were bumped.
 */
export async function bumpAccountPromptVersions(db: Database, accountId: string): Promise<number> {
  const rows = await db
    .update(agents)
    .set({ promptVersion: sql`${agents.promptVersion} + 1` })
    .where(eq(agents.accountId, accountId))
    .returning({ id: agents.id });
  return rows.length;
}

/**
 * Downloads a public SKILL.md into the account folder.
 * Input: skills root, account id, owner/repo@skill. Output: name plus catalog text.
 */
export async function installSkillFromSource(
  root: string,
  accountId: string,
  source: string,
): Promise<{ name: string; catalog: string }> {
  const spec = parseSkillSource(source);
  const urls = [
    `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/main/skills/${spec.skill}/SKILL.md`,
    `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/main/${spec.skill}/SKILL.md`,
    `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/main/SKILL.md`,
  ];
  let markdown = "";
  for (const url of urls) {
    const response = await fetch(url);
    if (!response.ok) continue;
    const text = await response.text();
    if (text.startsWith("---") && text.includes("name:")) {
      markdown = text;
      break;
    }
  }
  if (!markdown) {
    throw new Error(`Could not download SKILL.md for ${source}. Pass markdown if you already have the file.`);
  }
  const written = writeAccountSkill(root, accountId, markdown);
  return { name: written.name, catalog: catalogText(root, accountId) };
}
