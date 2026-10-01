/**
 * Sample plugin: demo_echo — echoes text (no network, no secrets).
 * Register from main.ts to verify plugin tools in chat.
 */
import { registerPluginTool, pluginStringInputSchema } from "../turn/plugins/registry.js";

export function registerSampleEchoPlugin(): void {
  registerPluginTool({
    server: "demo",
    name: "echo",
    description: "Echoes the given text back. Sample plugin for testing plugin tool wiring.",
    inputSchema: pluginStringInputSchema(),
    execute: async (_ctx, input) => {
      const text = String(input.text ?? "").trim();
      if (!text) return { error: "Pass non-empty text." };
      return { echo: text, from: "demo_echo plugin" };
    },
  });
}
