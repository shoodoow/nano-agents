import { readFileSync } from "node:fs";

const promptFileNames = ["identity", "voice", "autonomy", "security", "memory", "group", "skills"] as const;

/**
 * Builds the cacheable standing prompt for one turn.
 * Input: the agent's description.
 * Output: the seven static files, in a fixed order, followed by that description. The same files and description always return the same bytes.
 */
export function buildInstructions(description: string): string {
  const directory = new URL("../../../../prompts/", import.meta.url);
  const sections = promptFileNames.map((name) => readFileSync(new URL(`${name}.md`, directory), "utf8").trim());
  return [...sections, description].join("\n\n");
}
