/**
 * Loads prompt text from the repo's `prompts/` folder.
 * Why: every instruction a model reads lives in one reviewable place instead
 * of being scattered through the code as string constants. A file holds many
 * prompts, each under a level-1 heading (`# key`); text before the first
 * heading is a note for humans and is never sent. `{{name}}` placeholders are
 * filled from `vars`. Files are re-read when they change on disk, so a prompt
 * edit needs no restart. DB: none.
 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const promptsRoot = fileURLToPath(new URL("../../../../prompts/", import.meta.url));

type Loaded = { mtimeMs: number; sections: Map<string, string> };

const cache = new Map<string, Loaded>();

/** Splits one prompt file into its `# key` sections. */
export function parsePromptFile(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let key: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (key !== null) sections.set(key, lines.join("\n").trim());
  };
  for (const line of text.split("\n")) {
    const heading = line.match(/^# (\S.*)$/);
    if (heading) {
      flush();
      key = heading[1]!.trim();
      lines = [];
      continue;
    }
    lines.push(line);
  }
  flush();
  return sections;
}

function load(file: string): Map<string, string> {
  const path = `${promptsRoot}${file}.md`;
  const mtimeMs = statSync(path).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.sections;
  const sections = parsePromptFile(readFileSync(path, "utf8"));
  cache.set(file, { mtimeMs, sections });
  return sections;
}

/** Fills `{{name}}` placeholders. A placeholder with no value is a bug, so it throws. */
export function fillPrompt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Prompt variable {{${name}}} was not provided.`);
    return String(value);
  });
}

/**
 * Returns one prompt by file and key, with placeholders filled.
 * Input: file name under `prompts/` without `.md`, the `# key`, and values.
 * Output: the prompt text. Throws when the key is missing.
 */
export function prompt(file: string, key: string, vars?: Record<string, string | number>): string {
  const body = load(file).get(key);
  if (body === undefined) throw new Error(`Prompt "${key}" is missing from prompts/${file}.md.`);
  return fillPrompt(body, vars);
}

/** Same as `prompt`, but returns null when the key is absent (optional variants). */
export function optionalPrompt(file: string, key: string, vars?: Record<string, string | number>): string | null {
  const body = load(file).get(key);
  return body === undefined ? null : fillPrompt(body, vars);
}

/** Every key in one prompt file, in file order. */
export function promptKeys(file: string): string[] {
  return [...load(file).keys()];
}
