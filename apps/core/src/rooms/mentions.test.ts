import { describe, expect, it } from "vitest";
import { speakers } from "./mentions.js";

const members = [
  { id: "ada", name: "Ada" },
  { id: "bea", name: "Bea" },
  { id: "cy", name: "Cy" },
];

describe("speakers", () => {
  it("returns mentioned agents in the order they appear", () => {
    expect(speakers("@Ada @Bea", members, "cy")).toEqual(["ada", "bea"]);
  });

  it("returns only the owner when nobody is mentioned", () => {
    expect(speakers("hello", members, "cy")).toEqual(["cy"]);
  });

  it("ignores an unknown name and uses the same result for an agent reply", () => {
    const body = "@Nope @Ada";
    expect(speakers(body, members, "cy")).toEqual(["ada"]);
    expect(speakers(body, members, "cy")).toEqual(speakers(body, members, "cy"));
  });
});
