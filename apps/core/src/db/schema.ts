import { boolean, bigserial, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid, vector } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Embedding width for semantic recall (OpenAI text-embedding-3-small). */
export const EMBEDDING_DIMS = 1536;

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // Auto-review (Grok-style): risky tools wait for a person when true.
  autoReview: boolean("auto_review").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    label: text("label").notNull(),
    // Agent identity (Phase 17): role + personality + job_description.
    // The old freeform `description` blob is gone — no backward compatibility.
    role: text("role").notNull(),
    personality: text("personality").notNull().default(""),
    jobDescription: text("job_description").notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    /** Context window (tokens) from Vercel AI Gateway at hire / model change. */
    modelContextWindow: integer("model_context_window"),
    linuxProfile: text("linux_profile"),
    promptVersion: integer("prompt_version").notNull().default(1),
    notify: boolean("notify").notNull().default(true),
    pinned: boolean("pinned").notNull().default(false),
    hidden: boolean("hidden").notNull().default(false),
    // Bot mark (bot info page): Dot shape + color + material + optional photo.
    // Null means the legacy hash-colored face — old rows keep working.
    markShape: text("mark_shape"),
    markColor: text("mark_color"),
    markMaterial: text("mark_material"),
    markStyle: text("mark_style"),
    markGender: text("mark_gender"),
    avatarUrl: text("avatar_url"),
    // Teams (Phase 10): null for top-level hires, parent agent id for subagents.
    parentId: uuid("parent_id"),
    teamId: text("team_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("agents_account_id_linux_profile_unique").on(table.accountId, table.linuxProfile)],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    kind: text("kind").notNull(),
    ownerAgentId: uuid("owner_agent_id")
      .notNull()
      .references(() => agents.id),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("conversations_kind_check", sql`${table.kind} in ('direct', 'group')`)],
);

export const members = pgTable(
  "members",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.agentId] })],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    agentId: uuid("agent_id").references(() => agents.id),
    body: text("body").notNull(),
    // Rich protocol (Phase 08): text rows keep kind=text with null payload;
    // send_message rows store kind=rich plus a JSONB blocks array for images/widgets.
    kind: text("kind").notNull().default("text"),
    payload: jsonb("payload"),
    // Optional swipe-reply parent. Null means top-level. No FK to allow
    // backfill ordering; ownership is enforced in application code per account.
    replyTo: uuid("reply_to"),
    viaAgentId: uuid("via_agent_id").references(() => agents.id),
    // Run ledger (Phase 11): which turn produced this row. Null for rows
    // written before the ledger existed. Lets crash recovery, SSE resume,
    // and audits trace every bubble to its run.
    runId: uuid("run_id"),
    // Queued handoff (Phase 12): true when a user message arrived while its
    // room was busy. The scheduler drains these oldest-first. Indexed partial
    // so the drain tick stays cheap as threads grow.
    queued: boolean("queued").notNull().default(false),
    cacheReadTokens: integer("cache_read_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("messages_kind_check", sql`${table.kind} in ('text', 'rich')`),
    index("messages_queued_index").on(table.conversationId, table.createdAt).where(sql`${table.queued} = true`),
  ],
);

export const reactions = pgTable(
  "reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    // Null agentId = the human user reacted; non-null = an agent tapback.
    agentId: uuid("agent_id").references(() => agents.id),
    userKey: text("user_key").notNull().default("owner"),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("reactions_message_user_emoji_unique").on(table.messageId, table.userKey, table.emoji),
    check("reactions_emoji_check", sql`${table.emoji} in ('👍', '❤️', '👀', '🚀', '😮', '🎉', '✅', '❌')`),
  ],
);

export const delegations = pgTable(
  "delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    parentAgentId: uuid("parent_agent_id")
      .notNull()
      .references(() => agents.id),
    childAgentId: uuid("child_agent_id")
      .notNull()
      .references(() => agents.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    task: text("task").notNull(),
    status: text("status").notNull().default("running"),
    // Worker result (Phase 15): final text the background worker produced
    // (truncated), or the failure reason. Delivery reads this on settle.
    result: text("result"),
    // Compact live checkpoint for the manager/UI. Raw verbose tool traces stay
    // in the trace sink and never enter the manager's prompt automatically.
    progress: text("progress"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    // Billable usage for the worker's own generateText (up to 10 steps with
    // screenshots — the dominant cost; the dispatcher run row never sees it).
    // Null until the worker settles; stub-generate test workers stay null.
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    modelSteps: integer("model_steps"),
    // Delivery guard (Phase 19): auto-delivery flips this false->true exactly
    // once, so a worker success is posted to the room one time even if the
    // scheduler and the spawn call both race to deliver it.
    delivered: boolean("delivered").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("delegations_status_check", sql`${table.status} in ('running', 'done', 'failed')`)],
);

export const summaryKeys = ["decisions", "actions", "open", "entities", "corrections", "topics"] as const;

export const summaryItems = pgTable(
  "summary_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    key: text("key").notNull(),
    body: text("body").notNull(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id),
    // Semantic recall: folded items are embedded so older context can be pulled
    // back by relevance instead of dumping the whole summary every turn. Null
    // until the backfill embeds it (or when no embedding provider is configured).
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("summary_items_key_check", sql`${table.key} in ('decisions', 'actions', 'open', 'entities', 'corrections', 'topics')`),
    index("summary_items_embedding_index").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    scope: text("scope").notNull(),
    agentId: uuid("agent_id").references(() => agents.id),
    body: text("body").notNull(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id),
    // Semantic recall over durable facts (see summary_items.embedding).
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("memories_scope_check", sql`${table.scope} in ('agent', 'user')`),
    check(
      "memories_scope_agent_check",
      sql`(${table.scope} = 'user' and ${table.agentId} is null) or (${table.scope} = 'agent' and ${table.agentId} is not null)`,
    ),
    index("memories_embedding_index").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const toolApprovals = pgTable(
  "tool_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    tool: text("tool").notNull(),
    inputHash: text("input_hash").notNull(),
    summary: text("summary").notNull(),
    status: text("status").notNull().default("pending"),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("tool_approvals_status_check", sql`${table.status} in ('pending', 'approved', 'denied')`)],
);

export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    messageIds: uuid("message_ids").array().notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("proposals_kind_check", sql`${table.kind} in ('memory', 'skill', 'prompt')`),
    check("proposals_status_check", sql`${table.status} in ('pending', 'approved', 'rejected')`),
    check("proposals_message_ids_check", sql`cardinality(${table.messageIds}) > 0`),
  ],
);

export const routines = pgTable(
  "routines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    // Short label for the phone list / detail header (agent-chosen).
    title: text("title").notNull(),
    // Standing order the agent follows when the job fires (was `body`).
    instructions: text("instructions").notNull(),
    cron: text("cron").notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    // Self-managed routines (Phase 15): agents pause/resume their own jobs.
    // The scheduler skips paused routines; delete removes them entirely.
    paused: boolean("paused").notNull().default(false),
    timezone: text("timezone").notNull().default("UTC"),
    // Last finished fire (done/failed). Pending/running jobs do not write here.
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunStatus: text("last_run_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "routines_last_run_status_check",
      sql`${table.lastRunStatus} is null or ${table.lastRunStatus} in ('done', 'failed')`,
    ),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id),
    status: text("status").notNull().default("pending"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    // Concise outcome from this fire. The next fire receives it as continuity
    // context, while the full room transcript remains the audit source.
    result: text("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("jobs_status_check", sql`${table.status} in ('pending', 'running', 'done', 'failed')`)],
);

// Run ledger (Phase 11): one row per turn invocation (user message or
// routine). Replaces the old whole-turn transaction + row lock: a turn claims
// a running run, commits per step, heartbeats while the model works, and lands
// done/failed. A crash leaves running + stale heartbeat for the scheduler.
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    kind: text("kind").notNull().default("turn"),
    status: text("status").notNull().default("running"),
    error: text("error"),
    // Accurate billable usage for the whole run (sum of all model steps across
    // all speakers — AI SDK result.usage is already step-accumulated).
    // Null until the run lands; stub-generate test turns stay null.
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    modelSteps: integer("model_steps"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("runs_kind_check", sql`${table.kind} in ('turn', 'routine')`),
    check("runs_status_check", sql`${table.status} in ('running', 'done', 'failed')`),
    // Room serialization without a 2h lock: at most one running run per room.
    uniqueIndex("runs_one_running_per_conversation").on(table.conversationId).where(sql`${table.status} = 'running'`),
  ],
);

// Durable event log (Phase 13): every turn event persisted in the same short
// tx as its source row. SSE replays from a cursor, then tails live fanout.
// Same shape on replay and live so Redis Streams can slot in later unchanged.
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    runId: uuid("run_id").references(() => runs.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("events_type_check", sql`${table.type} in ('message', 'reaction', 'run', 'error', 'notify')`),
    index("events_conversation_id_id_index").on(table.conversationId, table.id),
  ],
);

// Push devices (Phase 14): one Expo push token per device per account.
// Token is opaque to us; delivery goes through the Expo Push API.
export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    expoPushToken: text("expo_push_token").notNull(),
    platform: text("platform"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("devices_expo_push_token_unique").on(table.expoPushToken)],
);

// Notify outbox (Phase 14): notify_user rows commit in the same tx as their
// trigger, so a crash redelivers instead of losing the ping. The scheduler
// relay applies delivery policy and flips pending -> sent/failed.
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    runId: uuid("run_id").references(() => runs.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    messageId: uuid("message_id").references(() => messages.id),
    // Pinging agent for tool pings (policy reads its notify flag). Null for
    // system pings (routine completion), which default to notify-allowed.
    agentId: uuid("agent_id").references(() => agents.id),
    title: text("title").notNull(),
    body: text("body").notNull(),
    urgency: text("urgency").notNull().default("info"),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("notifications_urgency_check", sql`${table.urgency} in ('info', 'action-needed')`),
    check("notifications_status_check", sql`${table.status} in ('pending', 'sent', 'failed')`),
  ],
);

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    url: text("url").notNull(),
    secret: text("secret").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    toolsCache: jsonb("tools_cache").notNull().default([]),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("mcp_servers_account_id_slug_unique").on(table.accountId, table.slug),
    check("mcp_servers_slug_check", sql`${table.slug} ~ '^[a-z][a-z0-9_-]{0,31}$'`),
  ],
);

export const providerKeys = pgTable(
  "provider_keys",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    provider: text("provider").notNull(),
    secret: text("secret").notNull(),
    baseUrl: text("base_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.provider] }),
    check("provider_keys_provider_check", sql`${table.provider} in ('openai', 'anthropic', 'xai', 'local')`),
  ],
);

// Tool secrets (Phase 15): search provider keys etc. live apart from model
// provider keys so model selection enums never leak tool credentials.
export const toolKeys = pgTable(
  "tool_keys",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    tool: text("tool").notNull(),
    secret: text("secret").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.tool] }),
    check("tool_keys_tool_check", sql`${table.tool} in ('brave', 'exa')`),
  ],
);

// Vault secrets: values users save from secret widgets (passwords, tokens).
// Sealed like provider keys and never listed — no read endpoint exists, so a
// bot that asks for a secret can never see it. Agents consume them later via
// env injection, never via chat.
export const accountSecrets = pgTable(
  "account_secrets",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    secret: text("secret").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.name] })],
);

// Agent worklists (Phase 15): one current todo list per agent, replaced
// wholesale like opencode's todowrite. Survives restarts; scoped per agent.
export const agentTodos = pgTable(
  "agent_todos",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    items: jsonb("items").notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.agentId] })],
);

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  accountId: uuid("account_id").references(() => accounts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
