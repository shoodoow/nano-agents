ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "auto_review" boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "tool_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id"),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id"),
  "tool" text NOT NULL,
  "input_hash" text NOT NULL,
  "summary" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tool_approvals_status_check" CHECK ("status" in ('pending', 'approved', 'denied'))
);
