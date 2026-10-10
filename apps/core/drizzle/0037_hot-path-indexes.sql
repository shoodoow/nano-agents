-- Indexes for the lookups that run on every poll, turn and scheduler tick.
-- Each was a full table scan that grew with the account's history.
CREATE INDEX IF NOT EXISTS "conversations_account_index" ON "conversations" ("account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_room_time_index" ON "runs" ("conversation_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_running_heartbeat_index" ON "runs" ("heartbeat_at") WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegations_room_time_index" ON "delegations" ("conversation_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegations_running_heartbeat_index" ON "delegations" ("heartbeat_at") WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_account_status_index" ON "notifications" ("account_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_status_run_at_index" ON "jobs" ("status", "run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_approvals_account_status_index" ON "tool_approvals" ("account_id", "status", "created_at");
--> statement-breakpoint
-- The chat card that shows an approval. Deciding one used to search every
-- message in the room as text to find its card.
ALTER TABLE "tool_approvals" ADD COLUMN IF NOT EXISTS "message_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL;
