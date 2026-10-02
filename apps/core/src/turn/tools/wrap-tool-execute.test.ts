import { describe, expect, it } from "vitest";
import { tailSlice } from "../util.js";
import { wrapToolExecute } from "./wrap-tool-execute.js";
import type { ToolContext } from "./context.js";

function ctx(): ToolContext {
  return {
    db: {} as never,
    store: {} as never,
    accountId: "a",
    conversationId: "c",
    agentId: "g",
    runId: "r",
    nextTime: () => new Date(),
    emittedMessages: [],
    emit: async () => {},
  };
}

describe("doom-loop detector", () => {
  it("stops the 3rd identical call without executing", async () => {
    const context = ctx();
    let runs = 0;
    const call = wrapToolExecute(context, "dispatcher", "check_worker", async () => {
      runs += 1;
      return { status: "running" };
    });
    const input = { workerId: "w1" };
    expect(await call(input)).toMatchObject({ status: "running" });
    expect(await call(input)).toMatchObject({ status: "running" });
    const third = (await call(input)) as { error?: string };
    expect(third.error).toMatch(/3 times in a row/);
    expect(runs).toBe(2);
  });

  it("resets when the input changes", async () => {
    const context = ctx();
    let runs = 0;
    const call = wrapToolExecute(context, "dispatcher", "send_message", async () => {
      runs += 1;
      return { ok: true };
    });
    await call({ text: "one" });
    await call({ text: "one" });
    await call({ text: "two" });
    expect(runs).toBe(3);
  });

  it("registers cheap linux tools on the dispatcher only when a profile exists", async () => {
    const { buildDispatcherToolSet } = await import("./build-tools.js");
    const base = ctx();
    const without = buildDispatcherToolSet("dispatcher", base);
    expect(Object.keys(without)).not.toContain("web_search");
    const withLinux = buildDispatcherToolSet("dispatcher", { ...base, linuxProfile: "ada" });
    expect(Object.keys(withLinux)).toEqual(expect.arrayContaining(["web_search", "web_fetch", "read", "glob", "grep"]));
    expect(Object.keys(withLinux)).not.toContain("bash");
  });
});

describe("tailSlice", () => {
  it("keeps short bodies intact and caps long ones", () => {
    expect(tailSlice("hello")).toBe("hello");
    const long = "x".repeat(2000);
    const sliced = tailSlice(long);
    expect(sliced.length).toBeLessThan(long.length);
    expect(sliced.endsWith("…")).toBe(true);
  });
});
