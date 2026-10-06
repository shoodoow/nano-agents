import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents } from "../db/schema.js";
import { accountSkillRoot, readSkillForAccount, skillCatalogForAccount } from "./skills.js";

type Database = Pick<ReturnType<typeof getDb>, "update">;

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
 * Kept for legacy host writers (MCP catalog skills, approved proposals).
 * Agent-facing installs go into the container via `npx skills add -g`.
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
