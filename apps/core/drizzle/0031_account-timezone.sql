DO $$ BEGIN
  ALTER TABLE "accounts" ADD COLUMN "timezone" text DEFAULT '' NOT NULL;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
