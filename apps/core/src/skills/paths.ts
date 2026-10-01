import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** apps/core (dev cwd and anchor for relative SKILLS_DIR in .env). */
export function coreAppRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function defaultRepoSkillsDir(): string {
  return join(coreAppRoot(), "..", "..", "skills");
}

/** Normalize SKILLS_DIR: relative paths are resolved from apps/core, not process.cwd(). */
export function resolveSkillsDir(envValue: string | undefined): string | undefined {
  const raw = envValue?.trim();
  if (!raw) {
    const fallback = defaultRepoSkillsDir();
    return existsSync(fallback) ? fallback : undefined;
  }
  const coreDir = coreAppRoot();
  return isAbsolute(raw) ? raw : join(coreDir, raw);
}
