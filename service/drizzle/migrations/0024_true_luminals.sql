CREATE TABLE "data_collection_epoch" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"collection_epoch" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_epoch_id_owner_key" UNIQUE("id","created_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "data_event" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"epoch_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"event_type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"batch_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"byte_length" integer NOT NULL,
	"raw_envelope" jsonb NOT NULL,
	CONSTRAINT "data_event_id_owner_key" UNIQUE("id","created_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "data_installation" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"revoked_at" timestamp with time zone,
	"last_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_installation_id_owner_key" UNIQUE("id","created_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "data_owner_state" (
	"created_by_user_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"stored_bytes" bigint DEFAULT 0 NOT NULL,
	"request_window_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_processing_job" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"processor_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_collection_epoch" ADD CONSTRAINT "data_epoch_installation_owner_fk" FOREIGN KEY ("installation_id","created_by_user_id") REFERENCES "public"."data_installation"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_event" ADD CONSTRAINT "data_event_epoch_owner_fk" FOREIGN KEY ("epoch_id","created_by_user_id") REFERENCES "public"."data_collection_epoch"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_installation" ADD CONSTRAINT "data_installation_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_owner_state" ADD CONSTRAINT "data_owner_state_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_processing_job" ADD CONSTRAINT "data_job_event_owner_fk" FOREIGN KEY ("event_id","created_by_user_id") REFERENCES "public"."data_event"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_epoch_source_idx" ON "data_collection_epoch" USING btree ("installation_id","collection_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "data_event_owner_event_idx" ON "data_event" USING btree ("created_by_user_id","event_id");--> statement-breakpoint
CREATE INDEX "data_event_owner_type_time_idx" ON "data_event" USING btree ("created_by_user_id","event_type","occurred_at","id");--> statement-breakpoint
CREATE INDEX "data_event_owner_receipt_idx" ON "data_event" USING btree ("created_by_user_id","received_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_installation_owner_source_idx" ON "data_installation" USING btree ("created_by_user_id","installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_job_event_version_idx" ON "data_processing_job" USING btree ("event_id","processor_version");--> statement-breakpoint
CREATE INDEX "data_job_due_idx" ON "data_processing_job" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "data_job_owner_status_idx" ON "data_processing_job" USING btree ("created_by_user_id","status");