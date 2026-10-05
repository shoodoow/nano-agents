DO $$ BEGIN
  ALTER TABLE "mcp_servers" ADD COLUMN "kind" text DEFAULT 'remote' NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_kind_check" CHECK ("kind" in ('remote', 'google'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "account_google_oauth" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts"("id") ON DELETE CASCADE,
  "secret" text NOT NULL,
  "scopes" text DEFAULT '' NOT NULL
);
