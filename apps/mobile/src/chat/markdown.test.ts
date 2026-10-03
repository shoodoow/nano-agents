import { describe, expect, it } from "vitest";
import { parseMarkdownBlocks } from "./markdown";

describe("parseMarkdownBlocks", () => {
  it("turns a pipe table into columns and keeps the surrounding prose", () => {
    const blocks = parseMarkdownBlocks(
      "Scan rows:\n\n| Vendor | Reach |\n|---|---|\n| **Octessa** | Shopify & WordPress only |\n\nSo what: merchants self-screen.",
    );
    expect(blocks).toEqual([
      { kind: "text", text: "Scan rows:" },
      {
        kind: "table",
        columns: ["Vendor", "Reach"],
        rows: [["**Octessa**", "Shopify & WordPress only"]],
      },
      { kind: "text", text: "So what: merchants self-screen." },
    ]);
  });

  it("rejoins a table cell that broke onto the next line", () => {
    const blocks = parseMarkdownBlocks("| Vendor | Reach |\n|---|---|\n| Threekit | Headless; OMS,\nDAM |");
    expect(blocks[0]).toEqual({
      kind: "table",
      columns: ["Vendor", "Reach"],
      rows: [["Threekit", "Headless; OMS, DAM"]],
    });
  });
});
