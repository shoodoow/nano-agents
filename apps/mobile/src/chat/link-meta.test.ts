import { describe, expect, it } from "vitest";
import { hostOf, parseLinkMeta } from "./link-meta";
import { extractUrls, messagePlainText, trimUrl } from "./markdown";

describe("parseLinkMeta", () => {
  it("prefers og:title and the touch icon, and makes the icon absolute", () => {
    const html = `<head><title>Fallback</title>
      <meta content="Tom &amp; Jerry&#39;s" property="og:title">
      <meta property="og:site_name" content="Example">
      <link rel="icon" href="/tab.ico"><link rel="apple-touch-icon" href="/touch.png"></head>`;
    expect(parseLinkMeta(html, "https://www.example.com/a/b?c=1")).toEqual({
      title: "Tom & Jerry's",
      site: "Example",
      icon: "https://www.example.com/touch.png",
    });
  });

  it("falls back to the title tag and /favicon.ico", () => {
    expect(parseLinkMeta("<title> Plain  page </title>", "https://example.com/x")).toEqual({
      title: "Plain page",
      site: null,
      icon: "https://example.com/favicon.ico",
    });
  });

  it("reads the host without www", () => {
    expect(hostOf("https://www.example.com:8080/path")).toBe("example.com");
  });
});

describe("links in message text", () => {
  it("drops trailing punctuation but keeps a paren the URL opened", () => {
    expect(trimUrl("https://a.example/x).")).toBe("https://a.example/x");
    expect(trimUrl("https://en.wikipedia.org/wiki/Rust_(language)")).toBe("https://en.wikipedia.org/wiki/Rust_(language)");
  });

  it("lists distinct bare and markdown links in order", () => {
    expect(
      extractUrls("See [docs](https://a.example/docs), then https://b.example/x. Again https://b.example/x"),
    ).toEqual(["https://a.example/docs", "https://b.example/x"]);
  });
});

describe("messagePlainText", () => {
  it("strips inline markers and turns a table widget into tab-separated rows", () => {
    expect(
      messagePlainText(
        [
          { kind: "text", markdown: "**Top** picks in `prod`" },
          { kind: "widget", widget: "table", props: { title: "Scores", columns: ["Name", "Score"], rows: [["Ada", "9"]] } },
        ],
        "fallback",
      ),
    ).toBe("Top picks in prod\n\nScores\nName\tScore\nAda\t9");
  });

  it("uses the body when there are no blocks", () => {
    expect(messagePlainText(null, "hello")).toBe("hello");
  });
});
