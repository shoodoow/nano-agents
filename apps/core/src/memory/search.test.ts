import { describe, expect, it } from "vitest";
import { hitLine, mergeRanked, searchTerms, type MemoryHit } from "./search.js";

const hit = (id: string, body: string, day: number): MemoryHit => ({
  source: "fact",
  id,
  body,
  messageId: null,
  at: new Date(Date.UTC(2026, 0, day)),
});

describe("searchTerms", () => {
  it("keeps distinctive words and drops filler", () => {
    expect(searchTerms("What did we decide about the Acme budget?")).toEqual(["decide", "acme", "budget"]);
  });

  it("keeps non-English words and numbers", () => {
    expect(searchTerms("بودجه Acme 12000")).toEqual(["بودجه", "acme", "12000"]);
  });

  it("returns nothing for filler only", () => {
    expect(searchTerms("yes ok do it")).toEqual([]);
  });
});

describe("mergeRanked", () => {
  it("lifts a hit that several lists agree on", () => {
    const merged = mergeRanked(
      [
        [hit("a", "alpha", 1), hit("b", "beta", 2)],
        [hit("b", "beta", 2), hit("c", "gamma", 3)],
      ],
      3,
    );
    expect(merged.map((item) => item.id)).toEqual(["b", "a", "c"]);
  });

  it("drops a second hit with the same text", () => {
    expect(mergeRanked([[hit("a", "same", 1)], [hit("z", "same", 1)]], 5)).toHaveLength(1);
  });
});

describe("hitLine", () => {
  it("leads with the date and ends with the message to open", () => {
    expect(hitLine({ ...hit("a", "Budget is 12k", 5), messageId: "m9" })).toBe("2026-01-05 · Budget is 12k [msg:m9]");
  });
});
