-- Image bytes may now live outside the database.
--
-- A hosted deployment runs against a free PostgreSQL tier measured in
-- hundreds of megabytes, and a few hundred slide photographs would fill
-- one. Where object storage is configured, the bytes go there and the
-- row keeps only the key.
--
-- The byte columns become nullable rather than being dropped: an
-- installation that has been storing images in the database keeps them,
-- and keeps serving them, with no migration of the data itself. Each row
-- carries either bytes or a key, and the route reads whichever is set.
ALTER TABLE "images" ALTER COLUMN "data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "images" ALTER COLUMN "thumb" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "data_key" varchar(200);--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "thumb_key" varchar(200);--> statement-breakpoint

-- A row with neither the bytes nor a key is an image that cannot be
-- served, which should never be written and is worth refusing outright.
ALTER TABLE "images" ADD CONSTRAINT "images_data_present_check"
  CHECK (("data" IS NOT NULL) OR ("data_key" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_thumb_present_check"
  CHECK (("thumb" IS NOT NULL) OR ("thumb_key" IS NOT NULL));
