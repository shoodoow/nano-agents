import { describe, expect, it } from "vitest";
import { globAlternatives, splitAbsoluteGlob } from "./find.js";

describe("splitAbsoluteGlob", () => {
  it("separates the literal directory from the wildcard part", () => {
    expect(splitAbsoluteGlob("/shared/demo/**/*.html")).toEqual({ base: "/shared/demo", rest: "**/*.html" });
    expect(splitAbsoluteGlob("/shared/demo/index.html")).toEqual({ base: "/shared/demo", rest: "index.html" });
  });

  it("leaves relative patterns to the given root", () => {
    expect(splitAbsoluteGlob("**/*.md")).toBeNull();
  });
});

describe("globAlternatives", () => {
  it("expands brace sets and lets star-star match the top folder", () => {
    expect(globAlternatives("**/*.{mp4,mov}")).toEqual(["**/*.mp4", "*.mp4", "**/*.mov", "*.mov"]);
    expect(globAlternatives("index.html")).toEqual(["index.html"]);
  });
});
