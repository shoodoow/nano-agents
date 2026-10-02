import { dispatcherToolNames, groupCreateInputSchema, toolsForSurface, workerToolNames } from "@nano-agents/agent-tools";
import { describe, expect, it } from "vitest";
import { profileToolNames } from "../../computer/profile-tools.js";

describe("agent-tools catalog", () => {
  it("matches dispatcher registration list", () => {
    expect(dispatcherToolNames()).toEqual([
      "add_to_group",
      "create_group",
      "create_routine",
      "delegate",
      "delete_group",
      "delete_routine",
      "hire_subagent",
      "list_groups",
      "list_routines",
      "list_team",
      "notify_user",
      "react_to_message",
      "read_history",
      "read_skill",
      "redirect_worker",
      "send_message",
      "spawn_worker",
      "stop_worker",
      "todo_list",
      "todo_write",
      "update_routine",
    ]);
  });

  it("worker names align with profile tools when Linux exists", () => {
    expect(workerToolNames(false)).toEqual(["read_history", "read_skill"]);
    for (const name of profileToolNames()) {
      expect(workerToolNames(true)).toContain(name);
    }
    expect(toolsForSurface("dispatcher").map((d) => d.name)).not.toContain("bash");
  });

  it("accepts title-only create_group", () => {
    expect(groupCreateInputSchema.parse({ title: "Team" })).toMatchObject({ memberIds: [] });
  });
});
