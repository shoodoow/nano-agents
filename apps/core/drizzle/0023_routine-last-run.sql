ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "last_run_at" timestamp with time zone;
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "last_run_status" text;
DO $$ BEGIN
  ALTER TABLE "routines" ADD CONSTRAINT "routines_last_run_status_check"
    CHECK ("last_run_status" IS NULL OR "last_run_status" IN ('done', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill from the newest finished job per routine.
UPDATE "routines" AS r
SET
  "last_run_at" = sub."run_at",
  "last_run_status" = sub."status"
FROM (
  SELECT DISTINCT ON ("routine_id")
    "routine_id",
    "run_at",
    "status"
  FROM "jobs"
  WHERE "status" IN ('done', 'failed')
  ORDER BY "routine_id", "run_at" DESC
) AS sub
WHERE r."id" = sub."routine_id"
  AND r."last_run_at" IS NULL;
