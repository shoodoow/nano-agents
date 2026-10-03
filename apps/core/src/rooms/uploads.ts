import type { MessageBlock } from "@nano-agents/shared";
import { execBytes, execStdin } from "../linux/linux.js";

// Why: phone attachments arrive as data: URIs. Stuffing megabytes of base64
// into the prompt (and forcing the model to re-emit them through a write
// tool) is slow, expensive, and lossy. Landing each file on the account Linux
// first lets the agent work with paths — cp/mv/open — like Grok handing a
// file to its computer. /shared/uploads is the handoff dir: every agent on
// the account can read it, and message ids keep each send isolated.
export const UPLOADS_ROOT = "/shared/uploads";
const MAX_FILES_PER_MESSAGE = 5;
const MAX_TOTAL_BYTES = 10_000_000;
const MAX_PREVIEW_CHARS = 700_000;
const MAX_OUTBOUND_FILE_BYTES = 5_000_000;

/**
 * Sanitizes an attachment filename for shell-safe writes.
 * Why: names come from the phone and end up inside sh -c; path traversal or
 * metacharacters must be impossible by construction. Pure for testing.
 * Input: raw name. Output: safe basename (fallback "file").
 */
export function sanitizeFileName(name: string): string {
  const base = name.split("/").pop()?.split("\\").pop() ?? "";
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return clean.length > 0 ? clean : "file";
}

/**
 * Splits a data: URI into mime + base64 payload.
 * Why: pure parse step so validation stays unit-testable without Docker.
 * Input: any url string. Output: {mime, base64} or null when not a data URI.
 */
export function parseDataUri(url: string): { mime: string; base64: string } | null {
  const match = /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) return null;
  return { mime: match[1]!, base64: match[2]! };
}

/**
 * Converts agent-created /shared files into real attachment bytes.
 * Why: /shared is a path inside the account computer, not a URL the phone can
 * open. Store a data URI; large payloads are stripped to blobRef on list and
 * fetched lazily by the client.
 */
export async function inlineSharedOutputBlocks(accountId: string, blocks: MessageBlock[]): Promise<MessageBlock[]> {
  const out: MessageBlock[] = [];
  for (const block of blocks) {
    if (block.kind !== "file" || !block.url.startsWith("/shared/")) {
      out.push(block);
      continue;
    }
    if (block.url.includes("\0") || block.url.split("/").includes("..")) {
      throw new Error("Shared attachment path is invalid.");
    }
    const bytes = await execBytes(accountId, ["cat", "--", block.url]);
    if (bytes.code !== 0) throw new Error(`Could not read attachment ${block.url}.`);
    if (bytes.stdout.length > MAX_OUTBOUND_FILE_BYTES) {
      throw new Error(`Attachment ${block.name} is larger than 5 MB. Send a smaller export.`);
    }
    const mime = block.mime || "application/octet-stream";
    out.push({
      ...block,
      url: `data:${mime};base64,${bytes.stdout.toString("base64")}`,
      savedPath: block.savedPath ?? block.url,
    });
  }
  return out;
}

/**
 * Materializes data: attachment blocks onto the account Linux.
 * Why: one exec per file via stdin (no ARG_MAX ceiling), per-file degrade to
 * passthrough so one bad file never sinks the message, images additionally
 * get a downscaled preview data URI for cheap vision grounding while the
 * full file stays on disk for the agent to open.
 * Input: account id, owning message id, validated blocks.
 * Output: blocks with savedPath (+previewUrl for images) where materialized.
 */
export async function materializeBlocks(
  accountId: string,
  messageId: string,
  blocks: MessageBlock[],
): Promise<MessageBlock[]> {
  const dir = `${UPLOADS_ROOT}/${messageId}`;
  let files = 0;
  let totalBytes = 0;
  const out: MessageBlock[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.kind !== "image" && block.kind !== "file") {
      out.push(block);
      continue;
    }
    const parsed = parseDataUri(block.url);
    if (!parsed || files >= MAX_FILES_PER_MESSAGE) {
      out.push(block);
      continue;
    }
    const bytes = Math.floor((parsed.base64.length * 3) / 4);
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      out.push(block);
      continue;
    }
    try {
      const fallbackName = block.kind === "image" ? `image-${index}.jpg` : `file-${index}`;
      const name = sanitizeFileName(block.kind === "image" ? block.alt ?? fallbackName : block.name);
      const path = `${dir}/${name}`;
      const written = await execStdin(
        accountId,
        ["sh", "-c", `mkdir -p ${dir} && base64 -d > ${path} && chmod 644 ${path}`],
        Buffer.from(parsed.base64, "utf8"),
      );
      if (written.code !== 0) {
        out.push(block);
        continue;
      }
      files += 1;
      totalBytes += bytes;
      if (block.kind === "image") {
        const previewUrl = await previewImage(accountId, path);
        out.push({ ...block, savedPath: path, ...(previewUrl ? { previewUrl } : {}) });
      } else {
        out.push({ ...block, savedPath: path });
      }
    } catch {
      out.push(block);
    }
  }
  return out;
}

/**
 * Builds a downscaled preview of a saved image for vision input.
 * Why: a 5MB phone photo costs ~1.5k tokens per million… actually ~765 tokens
 * per 1k px at detail-high; a 1568px preview keeps grounding accurate while
 * the prompt stays small. Returns null (agent still has the full file) when
 * ImageMagick is missing or the preview stays oversized.
 * Input: account id + saved image path. Output: data: JPEG URI or null.
 */
async function previewImage(accountId: string, path: string): Promise<string | null> {
  try {
    const resized = await execBytes(accountId, [
      "sh",
      "-c",
      `convert ${path} -resize 1568x1568\\> -quality 70 jpg:- | base64 -w0`,
    ]);
    if (resized.code !== 0) return null;
    const base64 = resized.stdout.toString("utf8").trim();
    if (base64.length === 0 || base64.length > MAX_PREVIEW_CHARS) return null;
    return `data:image/jpeg;base64,${base64}`;
  } catch {
    return null;
  }
}
