CREATE TABLE "location_visit_name" (
	"id" text PRIMARY KEY NOT NULL,
	"visit_key" text NOT NULL,
	"raw_event_id" text NOT NULL,
	"address" jsonb,
	"place" jsonb,
	"named_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "location_visit_name_visit_key" UNIQUE("created_by_user_id","visit_key")
);
--> statement-breakpoint
ALTER TABLE "location_observation" ADD COLUMN "visit_key" text;--> statement-breakpoint
ALTER TABLE "location_visit_name" ADD CONSTRAINT "location_visit_name_event_fk" FOREIGN KEY ("raw_event_id","created_by_user_id") REFERENCES "public"."data_event"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "location_observation_visit_idx" ON "location_observation" USING btree ("created_by_user_id","visit_key");--> statement-breakpoint
-- Backfill keys for v2 visits stored before this column existed.
UPDATE "location_observation" o SET "visit_key" = e."raw_envelope"->'payload'->>'visit_key' FROM "data_event" e WHERE e."id" = o."raw_event_id" AND e."created_by_user_id" = o."created_by_user_id" AND e."event_type" = 'location.visit.v2' AND o."visit_key" IS NULL;
