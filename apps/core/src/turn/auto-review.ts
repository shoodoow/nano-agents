/**
 * Auto-review: block risky tool calls until a person approves them.
 * Why: destructive shell and irreversible room/schedule
 * deletes wait on a card instead of running on the model's first try.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { getDb } from "../db/client.js";
import { accounts, messages, toolApprovals } from "../db/schema.js";
import { saveNotification } from "../notify/notify.js";
import { saveSendMessage } from "../rooms/send-message.js";
import type { ToolContext } from "./tools/context.js";

type Db = ReturnType<typeof getDb>;

export type AutoReviewDecision =
  | { allow: true }
  | { allow: false; blocked: true; approvalId: string; reason: string };

const DESTRUCTIVE_BASH = [
  /\brm\s+-[^\n]*rf\b/i,
  /\brm\s+-[^\n]*fr\b/i,
  /\brm\s+-[^\n]*\br\b[^\n]*\bf\b/i,
  /\brm\s+-[^\n]*\bf\b[^\n]*\br\b/i,
  /\bdd\s+if=/i,
  /\bmkfs(\.|$|\s)/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/i,
  /\bgit\s+push\b[^\n]*--force/i,
  /\bdrop\s+(table|database)\b/i,
  /\bmkfs\./i,
];

/**
 * Hashes a tool call without retry flags so approve-and-retry matches.
 * Input: tool name + raw input. Output: hex sha256.
 */
export function hashToolInput(name: string, input: Record<string, unknown>): string {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "requestApproval" || key === "approvalId") continue;
    // Stable order so the same batch delete retries match after approval.
    if (key === "routineIds" && Array.isArray(value)) {
      copy[key] = [...value].map(String).sort();
      continue;
    }
    copy[key] = value;
  }
  return createHash("sha256").update(`${name}:${JSON.stringify(copy)}`).digest("hex");
}

/**
 * Classifies whether this call is risky enough to wait on a person.
 * Input: tool name + args. Output: a one-line reason, or null when safe.
 */
export function classifyRisk(name: string, input: Record<string, unknown>): string | null {
  if (name === "bash") {
    const command = String(input.command ?? "");
    if (DESTRUCTIVE_BASH.some((pattern) => pattern.test(command))) {
      return `Destructive shell: ${command.slice(0, 160)}`;
    }
    return null;
  }
  if (name === "delete_group" && input.confirmed === true) {
    return `Delete group ${String(input.conversationId ?? "")}`.trim();
  }
  if (name === "delete_routine") {
    return `Delete routine ${String(input.routineId ?? "")}`.trim();
  }
  if (name === "gmail_send") {
    const to = String(input.to ?? input.draftId ?? "a recipient");
    return `Send email to ${to}`.slice(0, 180);
  }
  if (name === "delete_routines") {
    if (input.all === true) return "Delete all of your routines";
    const ids = Array.isArray(input.routineIds) ? input.routineIds.map(String) : [];
    const sorted = [...ids].sort();
    if (sorted.length === 0) return "Delete routines";
    if (sorted.length === 1) return `Delete routine ${sorted[0]}`;
    return `Delete ${sorted.length} routines`;
  }
  return null;
}

/**
 * Runs Auto-review for one tool call.
 * Input: tool context, name, args. Output: allow, or a blocked payload for the model.
 */
export async function reviewToolCall(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<AutoReviewDecision> {
  const reason = classifyRisk(name, input);
  if (!reason) return { allow: true };

  const [account] = await ctx.db
    .select({ autoReview: accounts.autoReview })
    .from(accounts)
    .where(eq(accounts.id, ctx.accountId));
  if (!account?.autoReview) return { allow: true };

  const hash = hashToolInput(name, input);
  const approvalId = typeof input.approvalId === "string" ? input.approvalId : "";
  const retry = input.requestApproval === true && approvalId.length > 0;

  if (retry) {
    const [row] = await ctx.db
      .select()
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.id, approvalId),
          eq(toolApprovals.accountId, ctx.accountId),
          eq(toolApprovals.tool, name),
          eq(toolApprovals.inputHash, hash),
        ),
      );
    if (!row) {
      return {
        allow: false,
        blocked: true,
        approvalId,
        reason: "That approval id does not match this tool call. Ask again or wait for the person.",
      };
    }
    if (row.status === "denied") {
      return {
        allow: false,
        blocked: true,
        approvalId: row.id,
        reason: "The person denied this action. Do not retry it. Take a safer path or ask what they want.",
      };
    }
    if (row.status === "approved" && !row.usedAt) {
      await ctx.db.update(toolApprovals).set({ usedAt: new Date() }).where(eq(toolApprovals.id, row.id));
      return { allow: true };
    }
    if (row.status === "approved") {
      return {
        allow: false,
        blocked: true,
        approvalId: row.id,
        reason: "That approval was already used. Ask the person again if you still need this.",
      };
    }
    if (row.status === "pending") {
      return {
        allow: false,
        blocked: true,
        approvalId: row.id,
        reason: `Auto-review is still waiting on the person (${row.id}). Do not reshape the command to slip past it.`,
      };
    }
  }

  const [existing] = await ctx.db
    .select()
    .from(toolApprovals)
    .where(
      and(
        eq(toolApprovals.accountId, ctx.accountId),
        eq(toolApprovals.conversationId, ctx.conversationId),
        eq(toolApprovals.tool, name),
        eq(toolApprovals.inputHash, hash),
        eq(toolApprovals.status, "approved"),
        isNull(toolApprovals.usedAt),
      ),
    )
    .limit(1);
  if (existing) {
    await ctx.db.update(toolApprovals).set({ usedAt: new Date() }).where(eq(toolApprovals.id, existing.id));
    return { allow: true };
  }

  const speakerId = ctx.voiceAgentId ?? ctx.agentId;
  const [created] = await ctx.db
    .insert(toolApprovals)
    .values({
      accountId: ctx.accountId,
      agentId: speakerId,
      conversationId: ctx.conversationId,
      tool: name,
      inputHash: hash,
      summary: reason.slice(0, 2000),
    })
    .returning();
  if (!created) throw new Error("Auto-review insert returned no row.");

  const saved = await saveSendMessage(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    agentId: speakerId,
    runId: ctx.runId,
    blocks: [
      {
        kind: "widget",
        widget: "approval",
        props: {
          title: "Needs approval",
          detail: reason,
          approvalId: created.id,
          tool: name,
        },
      },
    ],
    createdAt: ctx.nextTime(),
  });
  ctx.emittedMessages.push(saved);
  await ctx.emit({ type: "message", message: saved });
  const ping = await saveNotification(ctx.store, {
    accountId: ctx.accountId,
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    agentId: speakerId,
    messageId: saved.id,
    title: "Needs your approval",
    body: reason.slice(0, 280),
    urgency: "action-needed",
  });
  await ctx.emit({ type: "notify", notification: ping });

  return {
    allow: false,
    blocked: true,
    approvalId: created.id,
    reason:
      `Auto-review blocked this ${name} call. Tell the person in one sentence and wait. ` +
      `After they approve, retry the SAME call with requestApproval:true and approvalId:"${created.id}". ` +
      `Do not rewrite, encode, or route around it. Reason: ${reason}`,
  };
}

export async function getAutoReview(db: Db, accountId: string): Promise<boolean> {
  const [row] = await db.select({ autoReview: accounts.autoReview }).from(accounts).where(eq(accounts.id, accountId));
  return row?.autoReview ?? true;
}

export async function getAccountSettings(db: Db, accountId: string) {
  const [row] = await db
    .select({ autoReview: accounts.autoReview, timezone: accounts.timezone })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row ?? null;
}

/**
 * Stores the phone's zone the first time it arrives.
 * Why: later opens must not overwrite a zone the person already set.
 * Input: account id and a zone name. Output: the saved settings, or null.
 */
export async function rememberTimezone(db: Db, accountId: string, timezone: string) {
  const current = await getAccountSettings(db, accountId);
  if (!current) return null;
  if (current.timezone.trim()) return current;
  const [row] = await db
    .update(accounts)
    .set({ timezone })
    .where(eq(accounts.id, accountId))
    .returning({ autoReview: accounts.autoReview, timezone: accounts.timezone });
  return row ?? null;
}

export function isTimeZone(zone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export async function setAutoReview(db: Db, accountId: string, autoReview: boolean) {
  const [row] = await db
    .update(accounts)
    .set({ autoReview })
    .where(eq(accounts.id, accountId))
    .returning({ id: accounts.id, autoReview: accounts.autoReview });
  return row ?? null;
}

export async function listToolApprovals(db: Db, accountId: string) {
  return db
    .select()
    .from(toolApprovals)
    .where(and(eq(toolApprovals.accountId, accountId), eq(toolApprovals.status, "pending")));
}

export async function decideToolApproval(
  db: Db,
  accountId: string,
  approvalId: string,
  decision: "approved" | "denied",
) {
  const [row] = await db
    .update(toolApprovals)
    .set({ status: decision })
    .where(
      and(eq(toolApprovals.id, approvalId), eq(toolApprovals.accountId, accountId), eq(toolApprovals.status, "pending")),
    )
    .returning();
  if (row) return row;
  // Idempotent: a second tap after a successful approve must not 404.
  const [existing] = await db
    .select()
    .from(toolApprovals)
    .where(and(eq(toolApprovals.id, approvalId), eq(toolApprovals.accountId, accountId)));
  if (existing?.status === decision) return existing;
  return null;
}

/**
 * Writes approved/denied onto the chat approval card so the phone can hide the buttons.
 * Input: db + account/conversation + approval id + decision. Output: updated message or null.
 */
export async function markApprovalWidget(
  db: Db,
  accountId: string,
  conversationId: string,
  approvalId: string,
  decision: "approved" | "denied",
) {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        eq(messages.conversationId, conversationId),
        sql`${messages.payload}::text like ${`%${approvalId}%`}`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(5);
  const match = rows.find((row) => {
    if (!Array.isArray(row.payload)) return false;
    return (row.payload as { kind?: string; widget?: string; props?: { approvalId?: string } }[]).some(
      (block) => block.kind === "widget" && block.widget === "approval" && block.props?.approvalId === approvalId,
    );
  });
  if (!match || !Array.isArray(match.payload)) return null;
  const next = (match.payload as Record<string, unknown>[]).map((block) => {
    if (block.kind !== "widget" || block.widget !== "approval") return block;
    const props =
      block.props && typeof block.props === "object"
        ? { ...(block.props as Record<string, unknown>), status: decision }
        : { status: decision };
    return { ...block, props };
  });
  const [updated] = await db
    .update(messages)
    .set({ payload: next as never })
    .where(and(eq(messages.id, match.id), eq(messages.accountId, accountId)))
    .returning();
  return updated ?? null;
}

/** Cue that rewakes the room agent after a person decides an Auto-review card. */
export function approvalDecisionCue(
  row: { id: string; tool: string; summary: string },
  decision: "approved" | "denied",
): string {
  if (decision === "approved") {
    return (
      `The person approved "${row.summary}" (tool:${row.tool}, approvalId:${row.id}). ` +
      `Retry that SAME tool call now with requestApproval:true and approvalId:"${row.id}". Do not change the arguments.`
    );
  }
  return (
    `The person denied "${row.summary}" (tool:${row.tool}, approvalId:${row.id}). ` +
    `Do not retry it. Tell them briefly and continue with a safer path.`
  );
}
