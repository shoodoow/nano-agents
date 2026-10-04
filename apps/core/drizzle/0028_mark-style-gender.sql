-- Dot outfit + boy/girl toggle for the 3D mark (styles UI later).
DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "mark_style" text;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "mark_gender" text;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
