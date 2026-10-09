-- A worker's model conversation, saved after every few steps. It lets the
-- same worker continue a job with everything it already learned (a follow-up
-- from the agent, an approval, a core restart) instead of starting blank.
CREATE TABLE IF NOT EXISTS "worker_transcripts" (
  "delegation_id" uuid PRIMARY KEY REFERENCES "delegations"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "child_agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "messages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "steps" integer NOT NULL DEFAULT 0,
  "meta" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "worker_transcripts_child_index" ON "worker_transcripts" ("child_agent_id", "updated_at");
