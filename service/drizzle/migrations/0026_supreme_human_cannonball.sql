CREATE TABLE "agent_data_grant" (
	"created_by_user_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"history_days" integer DEFAULT 90 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_observation" (
	"id" text PRIMARY KEY NOT NULL,
	"raw_event_id" text NOT NULL,
	"epoch_id" text NOT NULL,
	"kind" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"horizontal_accuracy_m" double precision NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"arrival_at" timestamp with time zone,
	"departure_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "location_observation_event_key" UNIQUE("raw_event_id")
);
--> statement-breakpoint
ALTER TABLE "agent_data_grant" ADD CONSTRAINT "agent_data_grant_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_data_grant" ADD CONSTRAINT "agent_data_grant_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_observation" ADD CONSTRAINT "location_observation_event_fk" FOREIGN KEY ("raw_event_id","created_by_user_id") REFERENCES "public"."data_event"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_observation" ADD CONSTRAINT "location_observation_epoch_fk" FOREIGN KEY ("epoch_id","created_by_user_id") REFERENCES "public"."data_collection_epoch"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "location_observation_owner_time_idx" ON "location_observation" USING btree ("created_by_user_id","occurred_at","id");