/**
 * In-process plugin tools (MCP-style naming, local executors).
 * Why: one place to register extra dispatcher tools; names become server_tool in the SDK tool map.
 * DB: whatever each plugin execute writes.
 */
import { jsonSchema, type Schema } from "ai";
import type { AgentMode } from "../types.js";
import type { ToolContext } from "../tools/context.js";

export type PluginToolRegistration = {
  server: string;
  name: string;
  description: string;
  modes?: AgentMode[];
  inputSchema: Schema<unknown>;
  execute: (ctx: ToolContext, input: Record<string, unknown>) => Promise<unknown>;
};

const registrations: PluginToolRegistration[] = [];

export function registerPluginTool(entry: PluginToolRegistration): void {
  const full = pluginToolFullName(entry.server, entry.name);
  if (registrations.some((row) => pluginToolFullName(row.server, row.name) === full)) {
    return;
  }
  registrations.push({
    ...entry,
    modes: entry.modes ?? ["dispatcher"],
  });
}

export function pluginToolFullName(server: string, toolName: string): string {
  return `${server}_${toolName}`;
}

export function pluginToolOffers(): { server: string; tools: { name: string; description: string }[] }[] {
  const byServer = new Map<string, { name: string; description: string }[]>();
  for (const entry of registrations) {
    if (!entry.modes?.includes("dispatcher")) continue;
    const list = byServer.get(entry.server) ?? [];
    list.push({ name: entry.name, description: entry.description });
    byServer.set(entry.server, list);
  }
  return [...byServer.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, tools]) => ({ server, tools: tools.sort((a, b) => a.name.localeCompare(b.name)) }));
}

export function listPluginToolsForMode(mode: AgentMode): Array<PluginToolRegistration & { fullName: string }> {
  return registrations
    .filter((entry) => (entry.modes ?? ["dispatcher"]).includes(mode))
    .map((entry) => ({ ...entry, fullName: pluginToolFullName(entry.server, entry.name) }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** Helper for simple string-in / object-out plugins. */
export function pluginStringInputSchema(): Schema<{ text: string }> {
  return jsonSchema<{ text: string }>({
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  });
}
