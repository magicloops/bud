CREATE TABLE "health_sample_deletion" (
	"id" text PRIMARY KEY NOT NULL,
	"hk_uuid" text NOT NULL,
	"sample_kind" text NOT NULL,
	"raw_event_id" text NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "health_sample_deletion_sample_key" UNIQUE("created_by_user_id","hk_uuid"),
	CONSTRAINT "health_sample_deletion_kind_check" CHECK ("health_sample_deletion"."sample_kind" in ('workout','sleep_segment'))
);
--> statement-breakpoint
CREATE TABLE "health_sleep_segment" (
	"id" text PRIMARY KEY NOT NULL,
	"hk_uuid" text NOT NULL,
	"raw_event_id" text NOT NULL,
	"epoch_id" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"stage" text NOT NULL,
	"value" integer NOT NULL,
	"source_name" text NOT NULL,
	"source_bundle_id" text NOT NULL,
	"device_name" text,
	"device_model" text,
	"import_mode" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "health_sleep_segment_sample_key" UNIQUE("created_by_user_id","hk_uuid")
);
--> statement-breakpoint
CREATE TABLE "health_workout" (
	"id" text PRIMARY KEY NOT NULL,
	"hk_uuid" text NOT NULL,
	"raw_event_id" text NOT NULL,
	"epoch_id" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"duration_s" double precision NOT NULL,
	"activity_type" text NOT NULL,
	"activity_type_raw" integer,
	"total_energy_kcal" double precision,
	"total_distance_m" double precision,
	"indoor" boolean,
	"source_name" text NOT NULL,
	"source_bundle_id" text NOT NULL,
	"device_name" text,
	"device_model" text,
	"import_mode" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "health_workout_sample_key" UNIQUE("created_by_user_id","hk_uuid")
);
--> statement-breakpoint
ALTER TABLE "agent_data_grant" ADD COLUMN "health_types" jsonb DEFAULT '["workouts","sleep"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "health_sample_deletion" ADD CONSTRAINT "health_sample_deletion_event_fk" FOREIGN KEY ("raw_event_id","created_by_user_id") REFERENCES "public"."data_event"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_sleep_segment" ADD CONSTRAINT "health_sleep_segment_event_fk" FOREIGN KEY ("raw_event_id","created_by_user_id") REFERENCES "public"."data_event"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_sleep_segment" ADD CONSTRAINT "health_sleep_segment_epoch_fk" FOREIGN KEY ("epoch_id","created_by_user_id") REFERENCES "public"."data_collection_epoch"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_workout" ADD CONSTRAINT "health_workout_event_fk" FOREIGN KEY ("raw_event_id","created_by_user_id") REFERENCES "public"."data_event"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_workout" ADD CONSTRAINT "health_workout_epoch_fk" FOREIGN KEY ("epoch_id","created_by_user_id") REFERENCES "public"."data_collection_epoch"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_sleep_segment_owner_time_idx" ON "health_sleep_segment" USING btree ("created_by_user_id","start_at","id");--> statement-breakpoint
CREATE INDEX "health_workout_owner_time_idx" ON "health_workout" USING btree ("created_by_user_id","start_at","id");