import { describe, expect, it } from "vitest";
import { getModel } from "./get-model.js";

describe("getModel", () => {
  it("rejects a provider that has no SDK package", () => {
    expect(() => getModel("other", "m")).toThrow(/provider/);
  });

  it("accepts openai with a custom compatible base URL", () => {
    expect(() =>
      getModel("openai", "nvidia/nemotron-3-super-120b-a12b", "nvapi-test", "https://integrate.api.nvidia.com/v1"),
    ).not.toThrow();
  });
});
