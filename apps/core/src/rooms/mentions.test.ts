import { describe, expect, it } from "vitest";
import { addressedIds, mentionedIds, resolveMention } from "./mentions.js";

const members = [
  { id: "1", name: "Reviewer-969e", label: "Reviewer" },
  { id: "2", name: "ResearchBot-245o", label: "ResearchBot" },
  { id: "3", name: "Jimmy", label: "Social management" },
];

describe("resolveMention", () => {
  it("finds a teammate by handle, by short name, and by label", () => {
    expect(resolveMention("Reviewer-969e", members)).toBe("1");
    expect(resolveMention("reviewer", members)).toBe("1");
    expect(resolveMention("ResearchBot", members)).toBe("2");
    expect(resolveMention("jimmy", members)).toBe("3");
    expect(resolveMention("Nobody", members)).toBeNull();
  });
});

describe("addressedIds", () => {
  it("counts a name that opens the message, a line, or a sentence", () => {
    expect(addressedIds("@Reviewer please score this", members)).toEqual(["1"]);
    expect(addressedIds("Script is ready.\n@reviewer over to you", members)).toEqual(["1"]);
    expect(addressedIds("Looks good. @ResearchBot, tighten the hook", members)).toEqual(["2"]);
  });

  it("ignores a name dropped in passing", () => {
    expect(addressedIds("thanks @Reviewer for the earlier help, done here", members)).toEqual([]);
    expect(mentionedIds("thanks @Reviewer for the earlier help", members)).toEqual(["1"]);
  });
});
