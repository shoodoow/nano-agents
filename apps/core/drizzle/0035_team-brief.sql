-- The team's shared brief: goal, who does what, how work moves between
-- teammates, where files live. Shown to every member in that room.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "brief" text;
