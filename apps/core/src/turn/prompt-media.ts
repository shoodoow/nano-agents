/**
 * Vision and text extraction for model messages.
 * Why: keeps image/file part rules out of orchestration. DB: reads message payload shape only.
 */
import { parseDataUri } from "../rooms/uploads.js";
import { MAX_VISION_CHARS, MAX_VISION_IMAGES } from "./constants.js";
import { tailSlice } from "./util.js";

export type TurnImagePart =
  | { type: "file"; data: string; mediaType: string }
  | { type: "image"; image: string };

export type TurnMessageContent = string | Array<{ type: "text"; text: string } | TurnImagePart>;

export type HistoryRow = {
  id?: string;
  createdAt?: Date;
  agentId: string | null;
  body: string;
  payload: unknown;
  replyTo?: string | null;
  relayKind?: string | null;
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

/** A pause this long between two messages gets a date line, so the model sees time passing. */
const DATE_MARKER_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * Date line for a message that follows a long pause (or opens the window).
 * Why: a years-long thread reads as one continuous chat unless the dates are
 * visible; "last week" and "yesterday" only make sense against them.
 * Input: previous and current message times, the person's timezone.
 * Output: a bracketed date, or null when no marker is due.
 */
export function dateMarker(previous: Date | undefined, current: Date | undefined, timezone?: string): string | null {
  if (!current) return null;
  if (previous && current.getTime() - previous.getTime() < DATE_MARKER_GAP_MS) return null;
  try {
    const day = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone?.trim() || "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(current);
    return `[${day}]`;
  } catch {
    return `[${current.toISOString().slice(0, 10)}]`;
  }
}

/**
 * Builds model chat messages from recent history, with images and reply context.
 * Input: history rows (+ optional parent map for replyTo outside the window).
 * Output: role/content pairs for the model.
 */
/** Notes the person's reactions to agent messages since their previous message. */
function reactionNote(history: HistoryRow[], index: number, reactions?: Map<string, string[]>): string {
  if (!reactions || reactions.size === 0) return "";
  const notes: string[] = [];
  for (let at = index - 1; at >= 0 && history[at]!.agentId; at -= 1) {
    const row = history[at]!;
    const emojis = row.id ? reactions.get(row.id) : undefined;
    if (!emojis || emojis.length === 0) continue;
    const snippet = row.body.replace(/\s+/g, " ").trim().slice(0, 80);
    notes.unshift(`[they reacted ${emojis.join(" ")} to your message "${snippet}"]`);
  }
  return notes.join("\n");
}

export function toModelMessages(
  history: HistoryRow[],
  parents?: Map<string, ReplyParent>,
  timezone?: string,
  /** The person's emoji reactions, by the id of the message they reacted to. */
  reactions?: Map<string, string[]>,
  /** Who is reading. Other agents' messages are shown as theirs, by name. */
  reader?: { selfId: string; names: Map<string, string> },
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
    // In a group, a teammate's message is something said to this agent, not
    // by it. Sent as its own words, the model answered itself or stayed quiet.
    const other = Boolean(reader && row.agentId && row.agentId !== reader.selfId);
    const role = row.agentId && !other ? "assistant" : "user";
    const where = row.relayKind ? ", in the team chat" : "";
    const speaker = other ? `[${reader!.names.get(row.agentId!) ?? "teammate"}${where}]: ` : "";
    const body = `${speaker}${tailSlice(row.body)}`;
    const linked = row.replyTo ? formatReplyBody(body, byId.get(row.replyTo) ?? null) : body;
    const marker = dateMarker(history[index - 1]?.createdAt, row.createdAt, timezone);
    // A reaction is feedback on what the agent said. It rides on the person's
    // next message, so the agent sees it even when the tap did not wake it.
    const reacted = role === "user" && !other ? reactionNote(history, index, reactions) : "";
    const text = [marker, reacted, linked].filter(Boolean).join("\n");
    const parts = wanted.get(index);
    if (!parts || parts.length === 0) return { role, content: text };
    return {
      role,
      content: [{ type: "text", text }, ...parts],
    } as { role: "user" | "assistant"; content: TurnMessageContent };
  });
}
