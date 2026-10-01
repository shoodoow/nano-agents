-- Bot mark (bot info page): shape id + hex color + optional photo URL.
-- Nullable, so rows created before this migration keep the legacy face.
DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "mark_shape" text;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "mark_color" text;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "avatar_url" text;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
