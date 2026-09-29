-- Phase 12: queued handoff flag for busy-room user messages.
-- Idempotent: safe to run on DBs created by 0000-0010.
DO $$ BEGIN
  ALTER TABLE "messages" ADD COLUMN "queued" boolean DEFAULT false NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_queued_index" ON "messages" USING btree ("conversation_id","created_at") WHERE "messages"."queued" = true;
