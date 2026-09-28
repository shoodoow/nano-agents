CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('pending', 'running', 'done'))
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"body" text NOT NULL,
	"cron" text NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;