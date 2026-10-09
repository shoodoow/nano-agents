/**
 * Team conversations: asking a teammate in the group, and keeping the lead's
 * private chat with the person in step with what the team did.
 * Why: work between agents used to happen out of sight. A request to a
 * teammate is now a visible message in the group, the teammate answers there,
 * and the person's private chat gets a badge for each side of it plus the
 * lead's own summary.
 * DB: messages (group bubbles, relay badges in the direct chat), events.
 */
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { agents, conversations, delegations, messages } from "../db/schema.js";
import { appendEvent } from "../rooms/events.js";
import { publish } from "../rooms/stream.js";
import { prompt } from "../prompt/prompts.js";

type Db = ReturnType<typeof getDb>;
type MessageRow = typeof messages.$inferSelect;

/** Team rounds a lead may start on its own before it has to check in with the person. */
export const MAX_ROUNDS_WITHOUT_PERSON = 12;

/** Saves one message in a room and streams it to anyone watching that room. */
export async function postToRoom(
  db: Db,
  input: {
    accountId: string;
    conversationId: string;
    agentId: string;
    body: string;
    runId?: string | null;
    relay?: { kind: "from" | "to"; sourceConversationId: string; peers: { id: string; label: string }[] };
    createdAt?: Date;
  },
): Promise<MessageRow> {
  const [row] = await db
    .insert(messages)
    .values({
      accountId: input.accountId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      runId: input.runId ?? null,
      body: input.body,
      kind: "rich",
      payload: [{ kind: "text", markdown: input.body }],
      sourceConversationId: input.relay?.sourceConversationId ?? null,
      relayKind: input.relay?.kind ?? null,
      relayPeers: input.relay ? input.relay.peers : null,
      createdAt: input.createdAt ?? new Date(),
    })
    .returning();
  if (!row) throw new Error("Message insert returned no row.");
  const event = { type: "message" as const, message: row };
  try {
    const saved = await appendEvent(db, {
      accountId: input.accountId,
      conversationId: input.conversationId,
      runId: input.runId ?? null,
      event,
    });
    publish(input.accountId, input.conversationId, { ...event, cursor: saved.id });
  } catch {
    publish(input.accountId, input.conversationId, event);
  }
  return row;
}

/** The lead's private chat with the person, if it has one. */
export async function leadDirectRoom(db: Db, accountId: string, leadAgentId: string): Promise<string | null> {
  const [room] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(eq(conversations.accountId, accountId), eq(conversations.kind, "direct"), eq(conversations.ownerAgentId, leadAgentId)),
    )
    .orderBy(asc(conversations.createdAt))
    .limit(1);
  return room?.id ?? null;
}

/**
 * Drops "Message from X" badges into the lead's private chat for what
 * teammates said in the group.
 * Input: the group id, its lead, and the messages one round produced.
 * Output: how many badges were added.
 */
export async function relayTeamSpeech(
  db: Db,
  input: { accountId: string; groupId: string; leadAgentId: string; directRoomId: string; rows: MessageRow[] },
): Promise<number> {
  let added = 0;
  // One badge per teammate per round, carrying their last word. The whole
  // exchange is one tap away in the team chat; a badge per line buried the
  // lead's own summary.
  const lastByTeammate = new Map<string, MessageRow>();
  for (const row of input.rows) {
    if (!row.agentId || row.agentId === input.leadAgentId || row.relayKind) continue;
    lastByTeammate.set(row.agentId, row);
  }
  for (const row of lastByTeammate.values()) {
    if (!row.agentId) continue;
    const [already] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, input.directRoomId),
          eq(messages.sourceConversationId, input.groupId),
          eq(messages.agentId, row.agentId),
          eq(messages.body, row.body),
        ),
      )
      .limit(1);
    if (already) continue;
    await postToRoom(db, {
      accountId: input.accountId,
      conversationId: input.directRoomId,
      agentId: row.agentId,
      body: row.body,
      runId: row.runId,
      relay: { kind: "from", sourceConversationId: input.groupId, peers: [] },
    });
    added += 1;
  }
  return added;
}

/** Renders one round of group messages as lines the lead can read. */
export function teamRoundLines(rows: MessageRow[], names: Map<string, string>): string {
  return rows
    .filter((row) => row.agentId && !row.relayKind)
    .map((row) => {
      const who = names.get(row.agentId!) ?? "teammate";
      return `${who}: ${row.body.replace(/\s+/g, " ").trim().slice(0, 1_200)}`;
    })
    .join("\n");
}

/** How many team rounds this lead has started since the person last wrote anywhere. */
export async function roundsSincePerson(db: Db, accountId: string, leadAgentId: string): Promise<number> {
  const [lastPerson] = await db
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), isNull(messages.agentId)))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const since = lastPerson?.at ?? new Date(0);
  const rows = await db
    .select({ id: delegations.id })
    .from(delegations)
    .innerJoin(agents, eq(delegations.childAgentId, agents.id))
    .where(
      and(
        eq(delegations.accountId, accountId),
        eq(delegations.parentAgentId, leadAgentId),
        eq(agents.hidden, false),
        gt(delegations.createdAt, since),
      ),
    );
  return rows.length;
}

/**
 * After a round in a group that no person started, tells the lead in its
 * private chat what the team said, so the person hears about it there.
 * Input: the group, the round's messages, and a way to start a turn.
 * Output: nothing; a group with no lead chat or no new speech is left alone.
 */
export async function reportRoundToLead(
  db: Db,
  input: {
    accountId: string;
    groupId: string;
    groupTitle: string;
    leadAgentId: string;
    rows: MessageRow[];
    skillsRoot?: string;
  },
  startTurn: (conversationId: string, cue: string, speakerId: string) => Promise<unknown>,
): Promise<void> {
  const spoken = input.rows.filter((row) => row.agentId && !row.relayKind);
  if (spoken.length === 0) return;
  const directRoomId = await leadDirectRoom(db, input.accountId, input.leadAgentId);
  if (!directRoomId) return;
  await relayTeamSpeech(db, { ...input, directRoomId });
  const ids = [...new Set(spoken.map((row) => row.agentId!))];
  const people = await db
    .select({ id: agents.id, name: agents.name, label: agents.label })
    .from(agents)
    .where(eq(agents.accountId, input.accountId));
  const names = new Map(
    people.filter((row) => ids.includes(row.id)).map((row) => [row.id, row.id === input.leadAgentId ? "You" : row.label?.trim() || row.name]),
  );
  const cue = prompt("cues", "team-update", { group: input.groupTitle, lines: teamRoundLines(spoken, names) });
  await startTurn(directRoomId, cue, input.leadAgentId);
}

const clipLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/**
 * What an agent needs to know about its team for this turn.
 * Why: each room used to be an island. The lead in the group did not know what
 * it had agreed with the person in private, and in private it did not know
 * what the team had said. This puts the other room's latest lines, the team's
 * brief, and any teammate who failed to start in front of it every turn, so
 * awareness does not depend on the model choosing to look.
 * Input: the reader and the room it is speaking in. Output: text for the
 * prompt tail, or "" when the agent has no team.
 */
export async function teamContextFor(
  db: Db,
  input: { accountId: string; agentId: string; room: { id: string; kind: string; ownerAgentId: string | null; title: string; brief?: string | null } },
): Promise<string> {
  const people = await db
    .select({ id: agents.id, name: agents.name, label: agents.label })
    .from(agents)
    .where(eq(agents.accountId, input.accountId));
  const nameOf = (id: string | null): string => {
    if (!id) return "The person";
    if (id === input.agentId) return "You";
    const row = people.find((person) => person.id === id);
    return row?.label?.trim() || row?.name || "teammate";
  };
  const handleOf = (id: string): string => people.find((person) => person.id === id)?.name ?? "";
  const latest = async (conversationId: string, limit: number) =>
    (
      await db
        .select({ agentId: messages.agentId, body: messages.body, relayKind: messages.relayKind })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.accountId, input.accountId)))
        .orderBy(desc(messages.createdAt))
        .limit(limit)
    )
      .reverse()
      .filter((row) => !row.relayKind)
      .map((row) => `- ${nameOf(row.agentId)}: ${clipLine(row.body, 260)}`);
  const parts: string[] = [];

  if (input.room.kind === "group") {
    const leadId = input.room.ownerAgentId ?? "";
    const isLead = leadId === input.agentId;
    parts.push(
      prompt("dispatcher", isLead ? "team-room-lead" : "team-room-member", {
        lead: nameOf(leadId) === "You" ? "you" : nameOf(leadId),
        leadHandle: handleOf(leadId),
      }),
    );
    if (input.room.brief?.trim()) parts.push(`Team brief:\n${input.room.brief.trim().slice(0, 3_000)}`);
    if (isLead) {
      const directRoomId = await leadDirectRoom(db, input.accountId, input.agentId);
      const lines = directRoomId ? await latest(directRoomId, 8) : [];
      if (lines.length > 0) {
        parts.push(`Your private chat with the person, latest lines (the team cannot see these):\n${lines.join("\n")}`);
      }
    }
  } else {
    const groups = await db
      .select({ id: conversations.id, title: conversations.title, brief: conversations.brief })
      .from(conversations)
      .where(
        and(eq(conversations.accountId, input.accountId), eq(conversations.kind, "group"), eq(conversations.ownerAgentId, input.agentId)),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(3);
    for (const group of groups) {
      const lines = await latest(group.id, 10);
      parts.push(
        [
          `Your team chat "${group.title}" (you lead it; the person can open it but reads this private chat first).`,
          group.brief?.trim() ? `Brief: ${clipLine(group.brief, 700)}` : "No brief written yet; set_team_brief gives every teammate the goal and the workflow.",
          lines.length > 0 ? `Latest lines there:\n${lines.join("\n")}` : "Nothing has been said there yet.",
        ].join("\n"),
      );
    }
  }

  const failed = await db
    .select({ childAgentId: delegations.childAgentId, result: delegations.result, createdAt: delegations.createdAt })
    .from(delegations)
    .innerJoin(agents, eq(delegations.childAgentId, agents.id))
    .where(
      and(
        eq(delegations.accountId, input.accountId),
        eq(delegations.parentAgentId, input.agentId),
        eq(delegations.status, "failed"),
        eq(agents.hidden, false),
        gt(delegations.createdAt, new Date(Date.now() - 6 * 60 * 60 * 1000)),
      ),
    )
    .orderBy(desc(delegations.createdAt))
    .limit(3);
  if (failed.length > 0) {
    parts.push(
      `Requests that did not start:\n${failed
        .map((row) => `- ${nameOf(row.childAgentId)} could not take a request: ${clipLine(row.result ?? "unknown reason", 200)}`)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}
