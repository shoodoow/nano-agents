import { describe, expect, it } from "vitest";
import {
  parseApiError,
  parseExaResponse,
  parseBraveResponse,
  selectSearchProvider,
} from "./search.js";

describe("web search providers", () => {
  it("prefers Exa over Brave for agent search", () => {
    expect(selectSearchProvider({ exaKey: "x", braveKey: "y" })).toBe("exa");
    expect(selectSearchProvider({ braveKey: "y" })).toBe("brave");
    expect(selectSearchProvider({})).toBe("duckduckgo");
  });

  it("parses Exa results with contents text and highlights", () => {
    const raw = JSON.stringify({
      results: [
        {
          title: "Pricing",
          url: "https://docs.example/pricing",
          text: "Input tokens $3 per million.",
          highlights: ["$3 per million input"],
        },
      ],
    });
    const rows = parseExaResponse(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.snippet).toContain("$3 per million");
  });

  it("surfaces provider API errors", () => {
    expect(parseApiError('{"error":"Invalid API key"}')).toBe("Invalid API key");
    expect(parseBraveResponse('{"web":{"results":[{"title":"A","url":"https://a.com","description":"hi"}]}}')).toHaveLength(1);
  });
});
