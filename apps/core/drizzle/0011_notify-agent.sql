-- Phase 14: pinging agent on notifications for delivery policy.
-- Idempotent: safe to run on DBs created by 0000-0011.
DO $$ BEGIN
  ALTER TABLE "notifications" ADD COLUMN "agent_id" uuid;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
