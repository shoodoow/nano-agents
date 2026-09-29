export type ToolOffer = { name: string; description: string };

// Why: the tool catalog is part of the cache-stable prompt prefix (see
// memory/context.ts). Every tool the model can call must appear here sorted,
// otherwise the prefix bytes drift per turn and prompt caching misses.
// send_message/react are the agent voice; read_history/read_skill are recall;
// hire_subagent/delegate/list_team are the teams protocol; computer_* are the
// grounded desktop hands (screenshot/mouse/click/type/key on the assigned
// 1280x800 display — the same :N the viewer proxies).
const defaults: ToolOffer[] = [
  { name: "bash", description: "Run a shell command." },
  { name: "computer_click", description: "Move and left-click at x/y on your 1280x800 desktop." },
  { name: "computer_key", description: "Press one key combo (Return, Escape, ctrl+c)." },
  { name: "computer_mouse", description: "Move the pointer to x/y on your desktop." },
  { name: "computer_screenshot", description: "Take a PNG screenshot of your desktop for grounding." },
  { name: "computer_type", description: "Type text on your desktop." },
  { name: "delegate", description: "Ask a team agent to do a scoped task and report back." },
  { name: "hire_subagent", description: "Create a child specialist agent on your team." },
  { name: "list_team", description: "List agents on your team." },
  { name: "react_to_message", description: "Add one emoji tapback to a message." },
  { name: "read", description: "Read a file." },
  { name: "read_history", description: "Read a cited message or search slice." },
  { name: "read_skill", description: "Read one skill body by name." },
  { name: "send_message", description: "Send rich blocks (text/image/widget) to the user. Your only voice." },
  { name: "write", description: "Write a file." },
];

/**
 * Builds the tool list for one turn.
 * Input: the MCP tool lists, each with its server name.
 * Output: the default tools plus each plugin tool prefixed as server_tool, sorted by name.
 */
export function listTools(plugins: { server: string; tools: ToolOffer[] }[]): ToolOffer[] {
  const prefixed = plugins.flatMap((plugin) =>
    plugin.tools.map((tool) => ({
      name: `${plugin.server}_${tool.name}`,
      description: tool.description,
    })),
  );
  return [...defaults, ...prefixed].sort((left, right) => left.name.localeCompare(right.name));
}
