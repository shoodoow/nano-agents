import { localSkillCatalog, readLocalSkill } from "./local.js";
import {
  mergeSkillCatalogs,
  readSkillForAccount,
  skillCatalogForAccount,
  type SkillSummary,
} from "./skills.js";

export type AgentSkillContext = {
  skillsRoot?: string;
  accountId: string;
  /** Linux username; when set, `~/.agents/skills` in that home is merged in. */
  linuxProfile?: string | null;
};

/**
 * Skills this agent can load: host shared/account, then container-local overrides.
 * Why: shared procedures ship with the product; per-agent installs live only
 * inside the account container under `~/.agents/skills`.
 */
export async function skillCatalogForAgent(ctx: AgentSkillContext): Promise<SkillSummary[]> {
  const host = ctx.skillsRoot ? skillCatalogForAccount(ctx.skillsRoot, ctx.accountId) : [];
  const local = ctx.linuxProfile ? await localSkillCatalog(ctx.accountId, ctx.linuxProfile) : [];
  return mergeSkillCatalogs(host, local);
}

/**
 * Loads one skill body. Container-local wins, then host account, then shared.
 */
export async function readSkillForAgent(ctx: AgentSkillContext, name: string): Promise<string> {
  if (ctx.linuxProfile) {
    const local = await readLocalSkill(ctx.accountId, ctx.linuxProfile, name);
    if (local !== null) return local;
  }
  if (!ctx.skillsRoot) {
    throw new Error(`Skill ${name} is missing.`);
  }
  return readSkillForAccount(ctx.skillsRoot, ctx.accountId, name);
}

/** Catalog lines for tool responses (`name: description` per skill). */
export async function catalogTextForAgent(ctx: AgentSkillContext): Promise<string> {
  return (await skillCatalogForAgent(ctx))
    .map((skill) => `${skill.name}: ${skill.description}`)
    .join("\n");
}
