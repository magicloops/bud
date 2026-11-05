CREATE TABLE "location_visit" (
	"id" text PRIMARY KEY NOT NULL,
	"visit_key" text NOT NULL,
	"arrival_at" timestamp with time zone,
	"departure_at" timestamp with time zone,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"horizontal_accuracy_m" double precision NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"first_event_id" text NOT NULL,
	"last_event_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "location_visit_visit_key" UNIQUE("created_by_user_id","visit_key")
);
--> statement-breakpoint
CREATE INDEX "location_visit_owner_start_idx" ON "location_visit" USING btree ("created_by_user_id","started_at","id");--> statement-breakpoint
-- Backfill one visit per key from stored observations (v1 visits keyed by their raw event).
-- The completed report, then the most accurate one, supplies the coordinate.
INSERT INTO "location_visit" ("id", "visit_key", "arrival_at", "departure_at", "latitude", "longitude", "horizontal_accuracy_m",
  "started_at", "first_event_id", "last_event_id", "received_at", "created_by_user_id", "tenant_id")
SELECT 'lv_' || md5(agg.owner || ':' || agg.key), agg.key, agg.arrival, agg.departure, best.latitude, best.longitude,
  best.horizontal_accuracy_m, coalesce(agg.arrival, agg.departure, agg.first_occurred), agg.first_event, agg.last_event,
  agg.received, agg.owner, best.tenant_id
FROM (
  SELECT o."created_by_user_id" AS owner, coalesce(o."visit_key", 'v1:' || o."raw_event_id") AS key,
    min(o."arrival_at") AS arrival, max(o."departure_at") AS departure, min(o."occurred_at") AS first_occurred,
    (array_agg(o."raw_event_id" ORDER BY o."received_at", o."id"))[1] AS first_event,
    (array_agg(o."raw_event_id" ORDER BY o."received_at" DESC, o."id" DESC))[1] AS last_event,
    max(o."received_at") AS received
  FROM "location_observation" o WHERE o."kind" = 'visit' GROUP BY 1, 2
) agg
JOIN LATERAL (
  SELECT o."latitude", o."longitude", o."horizontal_accuracy_m", o."tenant_id" FROM "location_observation" o
  WHERE o."kind" = 'visit' AND o."created_by_user_id" = agg.owner AND coalesce(o."visit_key", 'v1:' || o."raw_event_id") = agg.key
  ORDER BY (o."departure_at" IS NULL), o."horizontal_accuracy_m", o."id" LIMIT 1
) best ON true
ON CONFLICT ("created_by_user_id", "visit_key") DO NOTHING;
