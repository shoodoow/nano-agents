-- Long-term memory that holds over years of chat.
-- memories: typed facts about named subjects; a changed fact supersedes the
-- old row instead of deleting it, so history stays and recall skips it.
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'fact' NOT NULL;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "subject" text;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "superseded_by" uuid;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "valid_from" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "memories" ADD CONSTRAINT "memories_kind_check"
    CHECK ("kind" in ('fact', 'person', 'org', 'project', 'preference', 'decision', 'commitment', 'profile'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_subject_index" ON "memories" ("account_id", lower("subject")) WHERE "subject" IS NOT NULL AND "superseded_by" IS NULL;
--> statement-breakpoint
-- summary_items: level 0 = one folded slice, 1 = month digest, 2 = year digest.
ALTER TABLE "summary_items" ADD COLUMN IF NOT EXISTS "level" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "summary_items" ADD COLUMN IF NOT EXISTS "period_start" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "summary_items" ADD COLUMN IF NOT EXISTS "period_end" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "summary_items_room_level_index" ON "summary_items" ("conversation_id", "level", "created_at");
--> statement-breakpoint
-- Fold watermark: the newest message already folded, so a fold reads only what is new.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "folded_through" timestamp with time zone;
--> statement-breakpoint
-- Full-text search that needs no embedding key. 'simple' keeps every word as
-- written, so names, handles and non-English text match.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', left("body", 20000))) STORED;
--> statement-breakpoint
ALTER TABLE "summary_items" ADD COLUMN IF NOT EXISTS "search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "body")) STORED;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("subject", '') || ' ' || "body")) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_search_index" ON "messages" USING gin ("search");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "summary_items_search_index" ON "summary_items" USING gin ("search");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_search_index" ON "memories" USING gin ("search");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_room_time_index" ON "messages" ("conversation_id", "created_at");
