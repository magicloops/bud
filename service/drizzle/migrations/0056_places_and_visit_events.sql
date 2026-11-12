CREATE TABLE "place" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"radius_m" double precision NOT NULL,
	"created_by" text NOT NULL,
	"geometry_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "place_owner_key" UNIQUE("id","created_by_user_id"),
	CONSTRAINT "place_radius_check" CHECK ("place"."radius_m" between 50 and 2000),
	CONSTRAINT "place_created_by_check" CHECK ("place"."created_by" in ('user', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "data_domain_event" DROP CONSTRAINT "data_domain_subject_check";
--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD COLUMN "visit_id" text;
--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD COLUMN "place_id" text;
--> statement-breakpoint
CREATE INDEX "place_owner_idx" ON "place" USING btree ("created_by_user_id","id");
--> statement-breakpoint
ALTER TABLE "location_visit" ADD CONSTRAINT "location_visit_owner_key" UNIQUE("id","created_by_user_id");
--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD CONSTRAINT "data_domain_visit_fk" FOREIGN KEY ("visit_id","created_by_user_id") REFERENCES "public"."location_visit"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD CONSTRAINT "data_domain_place_fk" FOREIGN KEY ("place_id","created_by_user_id") REFERENCES "public"."place"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "data_domain_visit_place_key" ON "data_domain_event" USING btree ("visit_id","event_type","place_id") WHERE "data_domain_event"."place_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "data_domain_visit_ended_key" ON "data_domain_event" USING btree ("visit_id","event_type") WHERE "data_domain_event"."visit_id" is not null and "data_domain_event"."place_id" is null;
--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD CONSTRAINT "data_domain_subject_check" CHECK (num_nonnulls("data_domain_event"."revision_id", "data_domain_event"."workout_id", "data_domain_event"."visit_id") = 1);
