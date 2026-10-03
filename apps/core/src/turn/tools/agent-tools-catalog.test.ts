import { dispatcherToolNames, groupCreateInputSchema, toolsForSurface, workerToolNames } from "@nano-agents/agent-tools";
import { describe, expect, it } from "vitest";
import { profileToolNames } from "../../computer/profile-tools.js";

describe("agent-tools catalog", () => {
  it("matches dispatcher registration list", () => {
    expect(dispatcherToolNames()).toEqual([
      "add_to_group",
      "correct_memory",
      "create_group",
      "create_routine",
      "delegate",
      "delete_group",
      "delete_routine",
      "delete_routines",
      "glob",
      "grep",
      "hire_subagent",
      "list_groups",
      "list_routines",
      "list_team",
      "notify_user",
      "react_to_message",
      "read",
      "read_history",
      "read_skill",
      "redirect_worker",
      "remember_fact",
      "send_message",
      "spawn_worker",
      "stop_worker",
      "todo_list",
      "todo_write",
      "update_routine",
      "web_fetch",
      "web_search",
    ]);
  });

  it("worker names align with profile tools when Linux exists", () => {
    expect(workerToolNames(false)).toEqual(["read_history", "read_skill"]);
    for (const name of profileToolNames()) {
      expect(workerToolNames(true)).toContain(name);
    }
    expect(toolsForSurface("dispatcher").map((d) => d.name)).not.toContain("bash");
    expect(toolsForSurface("dispatcher").map((d) => d.name)).toEqual(
      expect.arrayContaining(["web_search", "web_fetch", "read", "glob", "grep"]),
    );
  });

  it("accepts title-only create_group", () => {
    expect(groupCreateInputSchema.parse({ title: "Team" })).toMatchObject({ memberIds: [] });
  });
});
