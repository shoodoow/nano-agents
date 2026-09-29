import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../db/client.js";
import { createAccount } from "../roster/roster.js";
import { exec } from "../linux/linux.js";
import { blocksToText } from "./send-message.js";
import { stripBloatedBlocks } from "./rooms.js";
import { materializeBlocks, parseDataUri, sanitizeFileName } from "./uploads.js";
import { textOf, toImagePart, toModelMessages } from "./turn.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/nano_agents";
const db = getDb(databaseUrl);

afterAll(async () => {
  await db.$client.end();
});

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Locks attachment handling: filenames cannot escape the uploads dir, data
 * URIs parse purely, and vision mapping stays cheap (newest 3 only).
 */
describe("attachment pure helpers", () => {
  it("sanitizes filenames against traversal and metacharacters", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("my report (1).pdf")).toBe("my_report_1_.pdf");
    expect(sanitizeFileName("...")).toBe("file");
    expect(sanitizeFileName("a".repeat(200))).toHaveLength(120);
  });

  it("parses data URIs and rejects the rest", () => {
    expect(parseDataUri(tinyPng)?.mime).toBe("image/png");
    expect(parseDataUri("https://cdn.example/x.png")).toBeNull();
    expect(parseDataUri("data:image/pngnotbase64")).toBeNull();
  });

  it("renders saved paths so the agent opens files by path", () => {
    expect(
      blocksToText([{ kind: "file", url: "data:...", name: "bill.pdf", savedPath: "/shared/uploads/m/bill.pdf" }]),
    ).toBe("[file: bill.pdf (saved at /shared/uploads/m/bill.pdf)]");
    expect(blocksToText([{ kind: "image", url: tinyPng, alt: "chart" }])).toBe("[image: chart]");
  });

  it("attaches vision parts for the newest user images only", () => {
    const big = `data:image/png;base64,${"A".repeat(2_000_000)}`;
    const img = (id: string) => ({ agentId: null, body: id, payload: [{ kind: "image", url: tinyPng }] });
    const rows = [
      img("oldest"),
      img("older"),
      img("old"),
      { agentId: "agent-1", body: "ack", payload: null },
      { agentId: null, body: "new", payload: [{ kind: "image", url: tinyPng, previewUrl: "data:image/jpeg;base64,XYZ" }] },
      { agentId: null, body: "huge", payload: [{ kind: "image", url: big }] },
    ];
    const messages = toModelMessages(rows);
    // Budget is 3: newest three user images win; the oldest stays text-only.
    expect(messages[0]!.content).toBe("oldest");
    for (const index of [1, 2, 4]) {
      expect(Array.isArray(messages[index]!.content)).toBe(true);
    }
    expect(messages[3]!.content).toBe("ack");
    // data: URIs become file parts with exact mimes (no deprecation warnings).
    const parts = messages[4]!.content as { type: string; data?: string; mediaType?: string }[];
    expect(parts.map((part) => part.type)).toEqual(["text", "file"]);
    expect(parts[1]).toEqual({ type: "file", data: "XYZ", mediaType: "image/jpeg" });
    // Oversized originals are skipped (the agent opens those via savedPath).
    expect(messages[5]!.content).toBe("huge");
    expect(textOf(messages[4]!.content)).toBe("new");
    expect(textOf("plain")).toBe("plain");
  });

  it("keeps remote images as legacy parts and drops unusable refs", () => {
    expect(toImagePart("https://cdn.example/a.png")).toEqual({ type: "image", image: "https://cdn.example/a.png" });
    expect(toImagePart("http://evil.example/a.png")).toBeNull();
    expect(toImagePart("not a url")).toBeNull();
  });

  it("strips oversized data URIs into blobRefs, keeping small ones inline", () => {
    const big = `data:image/png;base64,${"A".repeat(300_000)}`;
    const stripped = stripBloatedBlocks("msg-9", [
      { kind: "text", markdown: "hi" },
      { kind: "image", url: big, alt: "photo" },
      { kind: "image", url: "https://cdn.example/a.png" },
    ]) as { kind: string; url?: string; blobRef?: { messageId: string; index: number } }[];
    expect(stripped[0]).toEqual({ kind: "text", markdown: "hi" });
    expect(stripped[1]!.url).toBe("");
    expect(stripped[1]!.blobRef).toEqual({ messageId: "msg-9", index: 1 });
    expect(stripped[2]).toEqual({ kind: "image", url: "https://cdn.example/a.png" });
  });
});

/**
 * Locks disk landing: a data: file decodes byte-identical onto the account
 * Linux under /shared/uploads/<messageId>, readable by every agent profile.
 */
describe("materializeBlocks", () => {
  it("writes data: attachments to the account Linux", async () => {
    const account = await createAccount(db, { name: "Uploads" });
    const text = `data:text/plain;base64,${Buffer.from("line one").toString("base64")}`;
    const landed = await materializeBlocks(account.id, "msg-1", [
      { kind: "text", markdown: "save this" },
      { kind: "file", url: text, name: "note.txt", mime: "text/plain" },
      { kind: "image", url: tinyPng, alt: "dot" },
      { kind: "file", url: "https://cdn.example/remote.pdf", name: "remote.pdf" },
    ]);
    expect(landed[0]).toEqual({ kind: "text", markdown: "save this" });
    const file = landed[1] as { kind: string; savedPath?: string };
    expect(file.savedPath).toBe("/shared/uploads/msg-1/note.txt");
    const read = await exec(account.id, ["cat", "/shared/uploads/msg-1/note.txt"]);
    expect(read.stdout).toBe("line one");
    const image = landed[2] as { kind: string; savedPath?: string };
    expect(image.savedPath).toBe("/shared/uploads/msg-1/dot");
    // Remote URLs are not ours to fetch: passthrough untouched.
    expect(landed[3]).toEqual({ kind: "file", url: "https://cdn.example/remote.pdf", name: "remote.pdf" });
  });
});
