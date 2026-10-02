import { readFileSync } from "node:fs";

/**
 * One agent's composed identity (Phase 17).
 * Why: three labeled fields compose in fixed order so the cached prefix is
 * stable. `name` grounds the @mention mesh; `role` is the job title;
 * `personality` is tone only; `job` carries the standing duties.
 */
export type AgentIdentity = {
  name: string;
  role: string;
  personality: string;
  job: string;
};

/**
 * Composes one agent's identity block in fixed order.
 * Why: fixed join keeps prefix bytes stable for provider caching — conditional
 * reordering would miss cache every turn. Empty personality omits its line.
 * Input: name/role/personality/job. Output: the identity block text.
 */
export function buildAgentIdentity(input: AgentIdentity): string {
  const head = `You are ${input.name} — ${input.role}.`;
  const tone = input.personality.trim()
    ? `Personality: ${input.personality.trim()}\n(This is your voice. Keep it consistent; do not drift into a generic assistant.)`
    : null;
  return [head, ...(tone ? [tone] : []), `Job:\n${input.job}`].join("\n\n");
}

/**
 * Builds the cacheable standing prompt for one turn.
 * Why: the system prompt plus the composed identity is the cache-stable
 * prefix — room/summary/messages always live after the breakpoint in the tail.
 * Input: an AgentIdentity.
 * Output: the standing system prompt followed by that identity block.
 */
export function buildInstructions(identity: AgentIdentity): string {
  const promptUrl = new URL("../../../../prompts/system.md", import.meta.url);
  const systemPrompt = readFileSync(promptUrl, "utf8").trim();
  return [systemPrompt, buildAgentIdentity(identity)].join("\n\n");
}
