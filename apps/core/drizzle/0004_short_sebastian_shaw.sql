CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"message_ids" uuid[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_kind_check" CHECK ("proposals"."kind" in ('memory', 'skill', 'prompt')),
	CONSTRAINT "proposals_status_check" CHECK ("proposals"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "proposals_message_ids_check" CHECK (cardinality("proposals"."message_ids") > 0)
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;