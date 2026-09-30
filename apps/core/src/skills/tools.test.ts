import { describe, expect, it } from "vitest";
import { profileToolNames } from "../computer/profile-tools.js";
import { workerToolNames } from "../rooms/subagents.js";
import { listTools } from "./tools.js";

describe("listTools", () => {
  it("includes the default tools and prefixes plugin tools, in a stable order", () => {
    const plugins = [
      { server: "pluginB", tools: [{ name: "search", description: "Search B." }] },
      { server: "pluginA", tools: [{ name: "search", description: "Search A." }] },
    ];
    const names = listTools(plugins).map((tool) => tool.name);
    expect(names).toEqual([
      "add_to_group",
      "check_worker",
      "create_group",
      "create_routine",
      "delegate",
      "delete_routine",
      "hire_subagent",
      "list_routines",
      "list_team",
      "notify_user",
      "pluginA_search",
      "pluginB_search",
      "react_to_message",
      "read_history",
      "read_skill",
      "send_message",
      "spawn_worker",
      "stop_worker",
      "todo_list",
      "todo_write",
      "update_routine",
    ]);
    expect(listTools(plugins).map((tool) => tool.name)).toEqual(names);
    for (const name of profileToolNames()) {
      expect(names).not.toContain(name);
    }
    expect(workerToolNames(true)).toEqual([...profileToolNames(), "read_history", "read_skill"].sort());
    expect(workerToolNames(true)).toContain("web_search");
    expect(workerToolNames(false)).toEqual(["read_history", "read_skill"]);
  });
});
