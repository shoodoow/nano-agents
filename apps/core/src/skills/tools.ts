import { listToolOffers } from "../turn/tools/catalog.js";

export type ToolOffer = { name: string; description: string };

/**
 * Builds the tool list for one turn (prompt prefix).
 * Input: MCP plugin tool lists.
 * Output: dispatcher catalog plus prefixed plugin tools, sorted by name.
 */
export function listTools(plugins: { server: string; tools: ToolOffer[] }[]): ToolOffer[] {
  const prefixed = plugins.flatMap((plugin) =>
    plugin.tools.map((tool) => ({
      name: `${plugin.server}_${tool.name}`,
      description: tool.description,
    })),
  );
  return [...listToolOffers("dispatcher"), ...prefixed].sort((left, right) => left.name.localeCompare(right.name));
}
