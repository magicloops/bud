ALTER TABLE "location_visit_name" ALTER COLUMN "raw_event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "location_visit_name" ADD COLUMN "source" text DEFAULT 'apple' NOT NULL;--> statement-breakpoint
ALTER TABLE "location_visit_name" ADD CONSTRAINT "location_visit_name_source_check" CHECK ("location_visit_name"."source" in ('apple', 'geoapify'));