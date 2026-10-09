/**
 * Full-text search over durable memory and old messages (Postgres tsvector).
 * Why: recall must work for every account, including ones with no embedding
 * key. The `simple` text config keeps words as written, so names, handles,
 * numbers and non-English text all match. Results from several lists are
 * merged by reciprocal rank, so full text and vectors can vote together.
 * DB: reads memories, summary_items, messages (generated `search` columns).
 */
import { sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";

type Db = ReturnType<typeof getDb>;

/** Words too common to help a search. Other languages pass through untouched. */
const STOPWORDS = new Set(
  "the and for are but not you your yours with that this these those have has had was were will would can could should what when where which who whom why how did does doing done from into about than then them they their there here just also please want need make made get got let lets its it's i'm i'll we've our out any all some more most very been being over under again once only same such too yes no ok okay".split(
    " ",
  ),
);

const MAX_TERMS = 12;

/**
 * Picks the words worth searching for.
 * Input: free text (a message, a question). Output: up to 12 distinct
 * lowercase words of 3+ letters, stopwords removed, in first-seen order.
 */
export function searchTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (raw.length < 3 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    if (seen.size >= MAX_TERMS) break;
  }
  return [...seen];
}

/** Any-word query for to_tsquery. Terms are plain words, so no operator can leak in. */
function anyOf(terms: string[]): string {
  return terms.join(" | ");
}

export type MemoryHit = {
  source: "fact" | "summary" | "message";
  id: string;
  body: string;
  /** Message to open with read_history for the full wording. */
  messageId: string | null;
  at: Date;
};

/** Current facts this agent may read that match any of the terms, best first. */
export async function searchFacts(
  db: Db,
  input: { accountId: string; agentId: string; terms: string[]; limit: number },
): Promise<MemoryHit[]> {
  if (input.terms.length === 0) return [];
  const query = anyOf(input.terms);
  const rows = await db.execute<{ id: string; body: string; message_id: string; at: Date }>(sql`
    select m.id, case when m.subject is null then m.body else m.subject || ': ' || m.body end as body,
           m.message_id, m.valid_from as at
    from memories m
    where m.account_id = ${input.accountId}
      and m.superseded_by is null
      and m.kind <> 'profile'
      and (m.scope = 'user' or (m.scope = 'agent' and m.agent_id = ${input.agentId}))
      and m.search @@ to_tsquery('simple', ${query})
    order by ts_rank_cd(m.search, to_tsquery('simple', ${query})) desc, m.valid_from desc
    limit ${input.limit}
  `);
  return rows.map((row) => ({ source: "fact", id: row.id, body: row.body, messageId: row.message_id, at: new Date(row.at) }));
}

/** Folded summary lines from rooms this agent belongs to that match any of the terms. */
export async function searchSummaries(
  db: Db,
  input: { accountId: string; agentId: string; terms: string[]; limit: number },
): Promise<MemoryHit[]> {
  if (input.terms.length === 0) return [];
  const query = anyOf(input.terms);
  const rows = await db.execute<{ id: string; body: string; message_id: string; at: Date }>(sql`
    select s.id, s.key || ': ' || s.body as body, s.message_id, coalesce(s.period_end, s.created_at) as at
    from summary_items s
    join members mb on mb.conversation_id = s.conversation_id and mb.account_id = s.account_id and mb.agent_id = ${input.agentId}
    where s.account_id = ${input.accountId}
      and s.search @@ to_tsquery('simple', ${query})
    order by ts_rank_cd(s.search, to_tsquery('simple', ${query})) desc, s.created_at desc
    limit ${input.limit}
  `);
  return rows.map((row) => ({ source: "summary", id: row.id, body: row.body, messageId: row.message_id, at: new Date(row.at) }));
}

/** Raw messages from rooms this agent belongs to that match, optionally inside a date range. */
export async function searchMessages(
  db: Db,
  input: { accountId: string; agentId: string; terms: string[]; limit: number; from?: Date; to?: Date },
): Promise<MemoryHit[]> {
  if (input.terms.length === 0) return [];
  const query = anyOf(input.terms);
  const from = input.from?.toISOString() ?? "-infinity";
  const to = input.to?.toISOString() ?? "infinity";
  const rows = await db.execute<{ id: string; body: string; at: Date; mine: boolean }>(sql`
    select msg.id, left(msg.body, 600) as body, msg.created_at as at, (msg.agent_id is not null) as mine
    from messages msg
    join members mb on mb.conversation_id = msg.conversation_id and mb.account_id = msg.account_id and mb.agent_id = ${input.agentId}
    where msg.account_id = ${input.accountId}
      and msg.created_at >= ${from}::timestamptz
      and msg.created_at <= ${to}::timestamptz
      and msg.search @@ to_tsquery('simple', ${query})
    order by ts_rank_cd(msg.search, to_tsquery('simple', ${query})) desc, msg.created_at desc
    limit ${input.limit}
  `);
  return rows.map((row) => ({
    source: "message",
    id: row.id,
    body: `${row.mine ? "agent" : "person"}: ${row.body}`,
    messageId: row.id,
    at: new Date(row.at),
  }));
}

/**
 * Merges ranked lists by reciprocal rank.
 * Why: full-text rank and vector distance are on different scales; position
 * in each list is comparable. An item found by several lists rises.
 * Input: lists, each best first. Output: one list, best first, no duplicates.
 */
export function mergeRanked(lists: MemoryHit[][], limit: number): MemoryHit[] {
  const score = new Map<string, { hit: MemoryHit; score: number }>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const key = `${hit.source}:${hit.id}`;
      const entry = score.get(key) ?? { hit, score: 0 };
      entry.score += 1 / (60 + rank);
      score.set(key, entry);
    });
  }
  const seenBodies = new Set<string>();
  return [...score.values()]
    .sort((left, right) => right.score - left.score || right.hit.at.getTime() - left.hit.at.getTime())
    .map((entry) => entry.hit)
    .filter((hit) => (seenBodies.has(hit.body) ? false : (seenBodies.add(hit.body), true)))
    .slice(0, limit);
}

/** One hit as a dated prompt line, with the id to open for the full wording. */
export function hitLine(hit: MemoryHit, bodyChars = 300): string {
  const date = hit.at.toISOString().slice(0, 10);
  const body = hit.body.replace(/\s+/g, " ").trim();
  const clipped = body.length > bodyChars ? `${body.slice(0, bodyChars)}…` : body;
  return `${date} · ${clipped}${hit.messageId ? ` [msg:${hit.messageId}]` : ""}`;
}
