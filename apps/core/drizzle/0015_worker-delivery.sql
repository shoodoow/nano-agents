-- Phase 19: worker success auto-delivery guard.
-- Exactly-once room posting for worker results; no backward-compat concerns.
DO $$ BEGIN
  ALTER TABLE "delegations" ADD COLUMN "delivered" boolean DEFAULT false NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
