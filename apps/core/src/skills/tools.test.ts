import { describe, expect, it } from "vitest";
import { listTools } from "./tools.js";

describe("listTools", () => {
  it("includes the default tools and prefixes plugin tools, in a stable order", () => {
    const plugins = [
      { server: "pluginB", tools: [{ name: "search", description: "Search B." }] },
      { server: "pluginA", tools: [{ name: "search", description: "Search A." }] },
    ];
    const names = listTools(plugins).map((tool) => tool.name);
    expect(names).toEqual([
      "bash",
      "check_worker",
      "computer_click",
      "computer_key",
      "computer_mouse",
      "computer_screenshot",
      "computer_type",
      "create_group",
      "create_routine",
      "delegate",
      "delete_routine",
      "glob",
      "grep",
      "hire_subagent",
      "list_routines",
      "list_team",
      "notify_user",
      "pluginA_search",
      "pluginB_search",
      "react_to_message",
      "read",
      "read_history",
      "read_skill",
      "send_message",
      "spawn_worker",
      "stop_worker",
      "todo_list",
      "todo_write",
      "update_routine",
      "web_fetch",
      "web_search",
      "write",
    ]);
    expect(listTools(plugins).map((tool) => tool.name)).toEqual(names);
  });
});
