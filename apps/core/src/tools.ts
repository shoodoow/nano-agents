export type ToolOffer = { name: string; description: string };

const defaults: ToolOffer[] = [
  { name: "read", description: "Read a file." },
  { name: "write", description: "Write a file." },
  { name: "bash", description: "Run a shell command." },
  { name: "computer", description: "Move the pointer, type, and take a screenshot." },
];

/**
 * Builds the tool list for one turn.
 * Input: the MCP tool lists, each with its server name.
 * Output: the four default tools plus each plugin tool prefixed as server_tool, sorted by name.
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
