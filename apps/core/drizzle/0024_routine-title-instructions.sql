ALTER TABLE "routines" ADD COLUMN "title" text;--> statement-breakpoint
UPDATE "routines" SET "title" = NULLIF(split_part(trim("body"), E'\n', 1), '');--> statement-breakpoint
UPDATE "routines" SET "title" = 'Untitled routine' WHERE "title" IS NULL;--> statement-breakpoint
ALTER TABLE "routines" ALTER COLUMN "title" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" RENAME COLUMN "body" TO "instructions";
