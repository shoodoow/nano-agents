ALTER TABLE "delegations" ADD COLUMN "progress" text;
ALTER TABLE "delegations" ADD COLUMN "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL;
