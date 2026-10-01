/**
 * The LLM summarizer used when the recent window ages messages out.
 * Why: folding must compress an old slice into a few durable, cited lines so
 * the thread stays sharp without the whole transcript in context. Output keys
 * match the summary schema (decisions/actions/open/entities/corrections/
 * topics). Every item cites the newest message in the slice so the fold
 * watermark advances. A model hiccup falls back to one compressed topics line,
 * so compaction always makes progress and never blocks a turn.
 */
import { generateText } from "ai";
import { summaryKeys } from "../db/schema.js";
import { getModel } from "../model/get-model.js";
import type { FoldSummarizer } from "./compaction.js";

const KEY_SET = new Set<string>(summaryKeys);
const MAX_ITEM = 500;
const MAX_ITEMS = 8;

const INSTRUCTION = `You compress an old slice of a chat into durable memory lines.
Write at most 8 lines. Each line is "<key>: <fact>" where key is one of:
decisions, actions, open, entities, corrections, topics.
- decisions: choices that were settled. actions: things done or promised.
- open: unresolved questions or pending work. entities: people, accounts, URLs, ids, numbers worth keeping.
- corrections: a fact that replaced an earlier one. topics: what the slice was about.
Keep only what a teammate would need weeks later. No pleasantries, no "the user said hi".
Be specific: keep names, handles, numbers, URLs verbatim. One fact per line. No extra prose.`;

export function llmFoldSummarizer(deps: {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl: string | null;
}): FoldSummarizer {
  return async (slice) => {
    const lastId = slice.at(-1)!.id;
    const transcript = slice
      .map((message) => `${message.agentId ? "agent" : "user"}: ${message.body.slice(0, 2000)}`)
      .join("\n");
    try {
      const result = await generateText({
        model: getModel(deps.provider, deps.modelId, deps.apiKey, deps.baseUrl),
        instructions: [{ role: "system" as const, content: INSTRUCTION }],
        messages: [{ role: "user", content: `Slice to compress:\n${transcript}` }],
      });
      const items = parseItems(result.text ?? "", lastId);
      if (items.length > 0) {
        return items;
      }
    } catch {
      // Fall through to the deterministic fallback below.
    }
    return [{ key: "topics", body: fallbackLine(slice), messageId: lastId }];
  };
}

function parseItems(text: string, messageId: string): { key: string; body: string; messageId: string }[] {
  const items: { key: string; body: string; messageId: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[-*\d.\s]+/, "").trim();
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const body = line.slice(at + 1).trim();
    if (!KEY_SET.has(key) || body.length === 0) continue;
    items.push({ key, body: body.slice(0, MAX_ITEM), messageId });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

function fallbackLine(slice: { agentId: string | null; body: string }[]): string {
  const joined = slice.map((message) => message.body.replace(/\s+/g, " ").trim()).join(" | ");
  return `Earlier ${slice.length} messages: ${joined}`.slice(0, MAX_ITEM);
}
