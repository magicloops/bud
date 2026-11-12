ALTER TABLE "place_presence" ADD COLUMN "leaving_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "place_presence" ADD COLUMN "arriving_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "place_presence" ADD COLUMN "arriving_event_id" text;--> statement-breakpoint
-- Waits pending before this migration settle as they did before it.
UPDATE "place_presence" SET "leaving_confirmed" = true WHERE "leaving_at" IS NOT NULL;
