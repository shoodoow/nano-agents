/**
 * Vision and text extraction for model messages.
 * Why: keeps image/file part rules out of orchestration. DB: reads message payload shape only.
 */
import { parseDataUri } from "../rooms/uploads.js";
import { MAX_VISION_CHARS, MAX_VISION_IMAGES } from "./constants.js";

export type TurnImagePart =
  | { type: "file"; data: string; mediaType: string }
  | { type: "image"; image: string };

export type TurnMessageContent = string | Array<{ type: "text"; text: string } | TurnImagePart>;

export type HistoryRow = {
  id?: string;
  agentId: string | null;
  body: string;
  payload: unknown;
  replyTo?: string | null;
};

export type ReplyParent = {
  body: string;
  agentId: string | null;
};

export function textOf(content: TurnMessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n");
}

export function toImagePart(ref: string): TurnImagePart | null {
  if (ref.startsWith("data:")) {
    const parsed = parseDataUri(ref);
    if (!parsed) return null;
    return { type: "file", data: parsed.base64, mediaType: parsed.mime };
  }
  try {
    const parsed = new URL(ref);
    if (parsed.protocol !== "https:") return null;
    return { type: "image", image: ref };
  } catch {
    return null;
  }
}

/**
 * Prefixes a reply with who/what it answers so the model sees the thread link.
 * Why: replyTo is stored on the row but the body alone ("yes" / "b") has no parent.
 */
export function formatReplyBody(body: string, parent: ReplyParent | null | undefined): string {
  if (!parent) {
    return body.includes("(Replying to") ? body : `(Replying to an earlier message)\n${body}`;
  }
  const who = parent.agentId ? "you" : "them";
  const quote = parent.body.replace(/\s+/g, " ").trim().slice(0, 240);
  return `(Replying to ${who}: "${quote}")\n${body}`;
}

/**
 * Builds model chat messages from recent history, with images and reply context.
 * Input: history rows (+ optional parent map for replyTo outside the window).
 * Output: role/content pairs for the model.
 */
export function toModelMessages(
  history: HistoryRow[],
  parents?: Map<string, ReplyParent>,
): { role: "user" | "assistant"; content: TurnMessageContent }[] {
  const byId = new Map<string, ReplyParent>();
  for (const row of history) {
    if (row.id) byId.set(row.id, { body: row.body, agentId: row.agentId });
  }
  if (parents) {
    for (const [id, parent] of parents) byId.set(id, parent);
  }

  const wanted = new Map<number, TurnImagePart[]>();
  let remaining = MAX_VISION_IMAGES;
  for (let index = history.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const row = history[index]!;
    if (row.agentId || !Array.isArray(row.payload)) continue;
    for (const block of row.payload) {
      if (remaining === 0) break;
      if (typeof block !== "object" || block === null || (block as { kind?: string }).kind !== "image") continue;
      const image = block as { url?: string; previewUrl?: string };
      const ref = typeof image.previewUrl === "string" && image.previewUrl.length > 0 ? image.previewUrl : image.url;
      if (typeof ref !== "string" || ref.length === 0 || ref.length > MAX_VISION_CHARS) continue;
      const part = toImagePart(ref);
      if (!part) continue;
      const list = wanted.get(index) ?? [];
      list.unshift(part);
      wanted.set(index, list);
      remaining -= 1;
    }
  }
  return history.map((row, index) => {
    const role = row.agentId ? "assistant" : "user";
    const text = row.replyTo ? formatReplyBody(row.body, byId.get(row.replyTo) ?? null) : row.body;
    const parts = wanted.get(index);
    if (!parts || parts.length === 0) return { role, content: text };
    return {
      role,
      content: [{ type: "text", text }, ...parts],
    } as { role: "user" | "assistant"; content: TurnMessageContent };
  });
}
