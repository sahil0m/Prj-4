-- Images gain a small copy, for where they are shown small.
--
-- Added nullable and backfilled before the NOT NULL goes on: a plain
-- "ADD COLUMN NOT NULL" with no default fails outright on a table that
-- already holds rows, which is every installation that has uploaded an
-- image before this migration runs.
--
-- The backfill points a row's thumbnail at its full image. That is
-- honest rather than ideal -- the bytes are simply the ones already
-- there -- and anything uploaded afterwards gets a real thumbnail.
ALTER TABLE "images" ADD COLUMN "thumb" "bytea";--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "thumb_bytes" integer;--> statement-breakpoint
UPDATE "images" SET "thumb" = "data", "thumb_bytes" = "bytes" WHERE "thumb" IS NULL;--> statement-breakpoint
ALTER TABLE "images" ALTER COLUMN "thumb" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "images" ALTER COLUMN "thumb_bytes" SET NOT NULL;
