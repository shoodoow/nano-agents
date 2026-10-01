-- Per-account MCP connectors (HTTP Streamable MCP). Secrets are sealed like provider keys.
CREATE TABLE IF NOT EXISTS "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"url" text NOT NULL,
	"secret" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"tools_cache" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_account_id_slug_unique" UNIQUE("account_id","slug"),
	CONSTRAINT "mcp_servers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "mcp_servers_slug_check" CHECK ("slug" ~ '^[a-z][a-z0-9_-]{0,31}$')
);
