import { describe, expect, it } from "vitest";
import { listTools } from "./tools.js";

describe("listTools", () => {
  it("includes the default tools and prefixes plugin tools, in a stable order", () => {
    const plugins = [
      { server: "pluginB", tools: [{ name: "search", description: "Search B." }] },
      { server: "pluginA", tools: [{ name: "search", description: "Search A." }] },
    ];
    const names = listTools(plugins).map((tool) => tool.name);
    expect(names).toEqual(["bash", "computer", "pluginA_search", "pluginB_search", "read", "write"]);
    expect(listTools(plugins).map((tool) => tool.name)).toEqual(names);
  });
});
