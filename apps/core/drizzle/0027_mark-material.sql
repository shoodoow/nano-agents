-- Dot Avatar Maker finish (plush, ceramic, glass…). Nullable for legacy rows.
DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "mark_material" text;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
