CREATE TABLE "place_presence_event" (
	"id" text PRIMARY KEY NOT NULL,
	"place_id" text NOT NULL,
	"transition" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"visit_id" text,
	"raw_event_id" text,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "place_presence_event_owner_key" UNIQUE("id","created_by_user_id"),
	CONSTRAINT "place_presence_event_transition_check" CHECK ("place_presence_event"."transition" in ('arrived', 'departed')),
	CONSTRAINT "place_presence_event_source_check" CHECK ("place_presence_event"."source" in ('region', 'visit'))
);
--> statement-breakpoint
CREATE TABLE "place_presence" (
	"place_id" text NOT NULL,
	"state" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"leaving_at" timestamp with time zone,
	"last_entered_at" timestamp with time zone,
	"visit_id" text,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "place_presence_pk" PRIMARY KEY("created_by_user_id","place_id"),
	CONSTRAINT "place_presence_state_check" CHECK ("place_presence"."state" in ('inside', 'outside'))
);
--> statement-breakpoint
ALTER TABLE "data_domain_event" DROP CONSTRAINT "data_domain_subject_check";--> statement-breakpoint
DROP INDEX "data_domain_visit_place_key";--> statement-breakpoint
DROP INDEX "data_domain_visit_ended_key";--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD COLUMN "presence_event_id" text;--> statement-breakpoint
ALTER TABLE "place_presence_event" ADD CONSTRAINT "place_presence_event_place_fk" FOREIGN KEY ("place_id","created_by_user_id") REFERENCES "public"."place"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_presence_event" ADD CONSTRAINT "place_presence_event_visit_fk" FOREIGN KEY ("visit_id","created_by_user_id") REFERENCES "public"."location_visit"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_presence" ADD CONSTRAINT "place_presence_place_fk" FOREIGN KEY ("place_id","created_by_user_id") REFERENCES "public"."place"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "place_presence_leaving_idx" ON "place_presence" USING btree ("leaving_at") WHERE "place_presence"."leaving_at" is not null;--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD CONSTRAINT "data_domain_presence_fk" FOREIGN KEY ("presence_event_id","created_by_user_id") REFERENCES "public"."place_presence_event"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hand-written: 6.4 place events (visit + place subject) become visit-sourced presence events
-- that keep the domain event's id; presence state follows each place's latest event.
INSERT INTO "place_presence_event" ("id", "place_id", "transition", "occurred_at", "source", "visit_id", "created_by_user_id", "created_at")
SELECT d."id", d."place_id", CASE d."event_type" WHEN 'place.arrived' THEN 'arrived' ELSE 'departed' END,
  CASE d."event_type" WHEN 'place.arrived' THEN coalesce(v."arrival_at", v."started_at") ELSE coalesce(v."departure_at", v."started_at") END,
  'visit', d."visit_id", d."created_by_user_id", d."published_at"
FROM "data_domain_event" d
JOIN "location_visit" v ON v."id" = d."visit_id" AND v."created_by_user_id" = d."created_by_user_id"
WHERE d."event_type" IN ('place.arrived', 'place.departed');--> statement-breakpoint
UPDATE "data_domain_event" SET "presence_event_id" = "id", "visit_id" = NULL
WHERE "event_type" IN ('place.arrived', 'place.departed');--> statement-breakpoint
INSERT INTO "place_presence" ("place_id", "state", "since", "last_entered_at", "visit_id", "created_by_user_id")
SELECT DISTINCT ON ("created_by_user_id", "place_id") "place_id",
  CASE "transition" WHEN 'arrived' THEN 'inside' ELSE 'outside' END, "occurred_at",
  CASE "transition" WHEN 'arrived' THEN "occurred_at" END,
  CASE "transition" WHEN 'arrived' THEN "visit_id" END, "created_by_user_id"
FROM "place_presence_event" ORDER BY "created_by_user_id", "place_id", "occurred_at" DESC, "id" DESC;--> statement-breakpoint
CREATE UNIQUE INDEX "data_domain_visit_ended_key" ON "data_domain_event" USING btree ("visit_id","event_type") WHERE "data_domain_event"."visit_id" is not null;--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD CONSTRAINT "data_domain_presence_key" UNIQUE("presence_event_id","event_type");--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD CONSTRAINT "data_domain_subject_check" CHECK (num_nonnulls("data_domain_event"."revision_id", "data_domain_event"."workout_id", "data_domain_event"."visit_id", "data_domain_event"."presence_event_id") = 1);