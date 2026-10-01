import { describe, expect, it } from "vitest";
import { profileToolNames } from "../computer/profile-tools.js";
import { workerToolNames } from "../rooms/subagents.js";
import { dispatcherToolNames } from "../turn/tools/registry.js";

describe("dispatcher SDK tools", () => {
  it("registers built-in dispatcher tools in stable sorted order", () => {
    const names = dispatcherToolNames();
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
    expect(dispatcherToolNames()).toEqual(names);
    for (const name of profileToolNames()) {
      expect(names).not.toContain(name);
    }
    expect(workerToolNames(true)).toEqual([...profileToolNames(), "read_history", "read_skill"].sort());
    expect(workerToolNames(true)).toContain("web_search");
    expect(workerToolNames(false)).toEqual(["read_history", "read_skill"]);
  });
});
