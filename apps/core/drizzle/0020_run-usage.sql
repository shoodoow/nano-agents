-- Accurate per-run usage: AI SDK result.usage (all-steps sum) lands on the run
-- when it finishes, so per-chat usage displays are DB-accurate instead of
-- trace-log estimates. Nullable: stub-generate test turns never call a model.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "input_tokens" integer;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "output_tokens" integer;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "cache_read_tokens" integer;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "cache_write_tokens" integer;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "reasoning_tokens" integer;
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "model_steps" integer;
