import { describe, expect, it } from "vitest";
import { dispatcherToolBudgetError, dispatcherToolBudgetMs } from "./dispatcher-tool-budget.js";

describe("dispatcher tool budgets", () => {
  it("does not cap coordination tools", () => {
    expect(dispatcherToolBudgetMs("send_message")).toBeNull();
    expect(dispatcherToolBudgetMs("spawn_worker")).toBeNull();
    expect(dispatcherToolBudgetMs("delegate")).toBeNull();
  });

  it("gives web tools a longer parent budget", () => {
    expect(dispatcherToolBudgetMs("web_fetch")).toBe(20_000);
    expect(dispatcherToolBudgetMs("web_search")).toBe(20_000);
    expect(dispatcherToolBudgetMs("read")).toBe(8_000);
  });

  it("formats timeout errors with seconds", () => {
    expect(dispatcherToolBudgetError(20_000)).toMatch(/20s/);
  });
});
