-- Phase 15: routine pause/timezone + worker result on delegations.
-- Idempotent: safe to run on DBs created by 0000-0012.
DO $$ BEGIN
  ALTER TABLE "delegations" ADD COLUMN "result" text;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "routines" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "routines" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
