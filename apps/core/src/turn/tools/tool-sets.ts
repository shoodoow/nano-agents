/**
 * Optional dispatcher tool sets (team, routines, admin).
 * Why: tool schemas are resent on every model step, and most turns in a
 * private chat never touch groups or schedules. A set is on from the start
 * when the room already uses it; otherwise the model turns it on with
 * `enable_tools`. Wording lives in prompts/tool-sets.md. DB: none.
 */
import { toolNamesInSet, toolSetNames, toolsForSurface, type ToolSetName } from "@nano-agents/agent-tools";
import { prompt } from "../../prompt/prompts.js";

const gatedBy = new Map<string, ToolSetName>(
  toolsForSurface("dispatcher")
    .filter((def) => def.set)
    .map((def) => [def.name, def.set!] as const),
);

export function isToolSetName(value: string): value is ToolSetName {
  return (toolSetNames as readonly string[]).includes(value);
}

/**
 * Picks the tools offered on one model step.
 * Input: every registered tool name and the sets that are on.
 * Output: ungated tools (built-ins, connectors, plugins) plus the enabled
 * sets. `enable_tools` disappears once nothing is left to enable.
 */
export function activeDispatcherTools(
  allNames: string[],
  enabled: ReadonlySet<string>,
  blocked: ReadonlySet<string> = new Set(),
): string[] {
  const allOn = toolSetNames.every((set) => enabled.has(set));
  return allNames.filter((name) => {
    if (blocked.has(name)) return false;
    if (name === "enable_tools") return !allOn;
    const set = gatedBy.get(name);
    return !set || enabled.has(set);
  });
}

/** How to use one set: returned by enable_tools and added to the prompt when the set starts on. */
export function toolSetGuidance(set: ToolSetName): string {
  return prompt("tool-sets", set);
}

/**
 * Sets that start on for a turn, from what the room already uses.
 * Input: room kind, whether the account has teammates or groups, whether this
 * agent has routines, whether this is a routine wake or a delegated turn.
 */
export function initialToolSets(input: {
  roomKind: string;
  hasTeam: boolean;
  hasRoutines: boolean;
  routineWake?: boolean;
  delegated?: boolean;
  /** A teammate in someone else's group: it hands work on by @mention, not with the lead's tools. */
  teamMember?: boolean;
}): ToolSetName[] {
  const sets: ToolSetName[] = [];
  if (!input.teamMember && (input.roomKind === "group" || input.hasTeam || input.delegated)) sets.push("team");
  if (input.hasRoutines || input.routineWake) sets.push("routines");
  return sets;
}

export { toolNamesInSet };

/**
 * Tools a teammate does not get in a group it does not lead.
 * Why: given the lead's tools, teammates tried to delegate to invented ids and
 * pinged the person directly. A teammate replies in the chat and names who is next.
 */
export const TEAM_MEMBER_BLOCKED = ["enable_tools", "notify_user"] as const;
