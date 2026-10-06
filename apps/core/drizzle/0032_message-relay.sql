DO $$ BEGIN
  ALTER TABLE "messages" ADD COLUMN "source_conversation_id" uuid;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" ADD COLUMN "relay_kind" text;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" ADD COLUMN "relay_peers" jsonb;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" ADD CONSTRAINT "messages_source_conversation_id_conversations_id_fk"
    FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" ADD CONSTRAINT "messages_relay_kind_check"
    CHECK ("relay_kind" is null or "relay_kind" in ('from', 'to'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
