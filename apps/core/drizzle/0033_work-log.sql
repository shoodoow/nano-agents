-- Work log: what an agent actually did during a run (tool calls, the private
-- note that woke it). Visible bubbles alone made the agent forget its own
-- work between turns and redo it; this is replayed, clipped, next to them.
CREATE TABLE IF NOT EXISTS "work_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "run_id" uuid REFERENCES "runs"("id") ON DELETE CASCADE,
  "cue" text,
  "entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_log_room_agent_index" ON "work_log" ("conversation_id", "agent_id", "created_at");
