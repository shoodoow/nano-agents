-- Phase 17: replace agent description blob with role + personality + job_description.
-- No backward compatibility: test data is wiped, the column is dropped.
DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "role" text DEFAULT '' NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "personality" text DEFAULT '' NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "job_description" text DEFAULT '' NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" DROP COLUMN "description";
EXCEPTION WHEN undefined_column THEN NULL; END $$;
