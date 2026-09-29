import { readFileSync } from "node:fs";

/**
 * Builds the cacheable standing prompt for one turn.
 * Input: the agent's description.
 * Output: the standing system prompt followed by that description.
 */
export function buildInstructions(description: string): string {
  const promptUrl = new URL("../../../../prompts/system.md", import.meta.url);
  const systemPrompt = readFileSync(promptUrl, "utf8").trim();
  return [systemPrompt, description].join("\n\n");
}
