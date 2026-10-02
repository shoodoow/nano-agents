-- Worker usage was never recorded: runWorker calls generateText directly, so
-- OpenRouter billed 10-step screenshot runs the per-chat display never saw.
-- Same nullable columns as runs; stub-generate test workers stay null.
ALTER TABLE "delegations" ADD COLUMN IF NOT EXISTS "input_tokens" integer;
ALTER TABLE "delegations" ADD COLUMN IF NOT EXISTS "output_tokens" integer;
ALTER TABLE "delegations" ADD COLUMN IF NOT EXISTS "cache_read_tokens" integer;
ALTER TABLE "delegations" ADD COLUMN IF NOT EXISTS "cache_write_tokens" integer;
ALTER TABLE "delegations" ADD COLUMN IF NOT EXISTS "reasoning_tokens" integer;
ALTER TABLE "delegations" ADD COLUMN IF NOT EXISTS "model_steps" integer;
