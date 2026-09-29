-- Phase 15b: tool secrets + agent worklists.
-- Idempotent: safe to run on DBs created by 0000-0013.
CREATE TABLE IF NOT EXISTS "agent_todos" (
	"account_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_todos_account_id_agent_id_pk" PRIMARY KEY("account_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_keys" (
	"account_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_keys_account_id_tool_pk" PRIMARY KEY("account_id","tool"),
	CONSTRAINT "tool_keys_tool_check" CHECK ("tool_keys"."tool" in ('brave', 'exa'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_todos" ADD CONSTRAINT "agent_todos_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_todos" ADD CONSTRAINT "agent_todos_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tool_keys" ADD CONSTRAINT "tool_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
