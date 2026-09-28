import { describe, expect, it } from "vitest";
import { getModel } from "./get-model.js";

describe("getModel", () => {
  it("rejects a provider that has no SDK package", () => {
    expect(() => getModel("other", "m")).toThrow(/provider/);
  });
});
