import type { MessageBlock } from "../api";

export type SharedFile = {
  name: string;
  url: string;
  mime?: string;
  conversationId?: string;
  blobRef?: { messageId: string; index: number };
};

export type SharedImage = { label: string; url: string };

const URL_RE = /https?:\/\/[^\s)>\]]+/g;

/** Pulls links, images, and files out of chat rows for the room tabs. */
export function collectShares(messages: { conversationId?: string; body: string; blocks?: MessageBlock[] | null }[]): {
  links: string[];
  media: SharedImage[];
  files: SharedFile[];
} {
  const links = new Set<string>();
  const media: SharedImage[] = [];
  const files: SharedFile[] = [];
  const seenFiles = new Set<string>();
  for (const message of messages) {
    harvest(message.body, links);
    for (const block of message.blocks ?? []) {
      if (block.kind === "text") harvest(block.markdown, links);
      if (block.kind === "image" && (block.url || block.previewUrl)) {
        media.push({ label: block.alt || "Image", url: block.previewUrl || block.url });
      }
      if (block.kind === "file") {
        const key = `${block.name}:${block.url}`;
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        files.push({
          name: block.name,
          url: block.url,
          mime: block.mime,
          conversationId: message.conversationId,
          blobRef: block.blobRef,
        });
      }
    }
  }
  return { links: [...links], media, files };
}

function harvest(text: string, links: Set<string>): void {
  for (const match of text.matchAll(URL_RE)) links.add(match[0].replace(/[.,;]+$/, ""));
}
