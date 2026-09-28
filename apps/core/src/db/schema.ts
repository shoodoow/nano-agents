import { boolean, check, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
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
    description: text("description").notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    linuxProfile: text("linux_profile"),
    promptVersion: integer("prompt_version").notNull().default(1),
    notify: boolean("notify").notNull().default(true),
    pinned: boolean("pinned").notNull().default(false),
    hidden: boolean("hidden").notNull().default(false),
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

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  agentId: uuid("agent_id").references(() => agents.id),
  body: text("body").notNull(),
  cacheReadTokens: integer("cache_read_tokens"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("summary_items_key_check", sql`${table.key} in ('decisions', 'actions', 'open', 'entities', 'corrections', 'topics')`)],
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("memories_scope_check", sql`${table.scope} in ('agent', 'user')`),
    check(
      "memories_scope_agent_check",
      sql`(${table.scope} = 'user' and ${table.agentId} is null) or (${table.scope} = 'agent' and ${table.agentId} is not null)`,
    ),
  ],
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

export const routines = pgTable("routines", {
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
  body: text("body").notNull(),
  cron: text("cron").notNull(),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("jobs_status_check", sql`${table.status} in ('pending', 'running', 'done')`)],
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
