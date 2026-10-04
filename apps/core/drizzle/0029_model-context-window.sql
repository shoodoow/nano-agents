DO $$ BEGIN
  ALTER TABLE "agents" ADD COLUMN "model_context_window" integer;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;
