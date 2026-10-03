import { describe, expect, it } from "vitest";
import { collectShares } from "./shares";

describe("collectShares", () => {
  it("keeps https links and file blocks from the same thread", () => {
    const shares = collectShares([
      { body: "bash: https://octessa.com/\nhttps://octessa.com/compare/cylindo-alternative", blocks: [{ kind: "text", markdown: "https://octessa.com/" }] },
      {
        body: "Here it is",
        blocks: [
          { kind: "text", markdown: "Here it is" },
          { kind: "file", url: "data:text/csv;base64,YQ==", name: "octessa-competitors.csv", mime: "text/csv" },
        ],
      },
    ]);
    expect(shares.links).toEqual(["https://octessa.com/", "https://octessa.com/compare/cylindo-alternative"]);
    expect(shares.files.map((file) => file.name)).toEqual(["octessa-competitors.csv"]);
  });
});
