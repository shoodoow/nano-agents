import { describe, expect, it } from "vitest";
import { listTools } from "../skills/tools.js";
import { listPluginToolsForMode, pluginToolFullName } from "../turn/plugins/registry.js";
import { registerSampleEchoPlugin } from "./sample-echo.js";

describe("sample echo plugin", () => {
  it("registers demo_echo in catalog and can execute", async () => {
    registerSampleEchoPlugin();
    expect(pluginToolFullName("demo", "echo")).toBe("demo_echo");
    const names = listTools([{ server: "demo", tools: [{ name: "echo", description: "x" }] }]).map((t) => t.name);
    expect(names).toContain("demo_echo");
    const [tool] = listPluginToolsForMode("dispatcher").filter((t) => t.fullName === "demo_echo");
    expect(tool).toBeDefined();
    const out = await tool!.execute({} as never, { text: "hi" });
    expect(out).toEqual({ echo: "hi", from: "demo_echo plugin" });
  });
});
