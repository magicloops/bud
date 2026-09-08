CREATE TABLE "contact_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"scan_id" text NOT NULL,
	"fields" jsonb NOT NULL,
	"visible" boolean NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "contact_revision_identity_key" UNIQUE("contact_id","scan_id"),
	CONSTRAINT "contact_revision_owner_key" UNIQUE("id","created_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "contact_scan_record" (
	"id" text PRIMARY KEY NOT NULL,
	"scan_id" text NOT NULL,
	"raw_event_id" text NOT NULL,
	"client_event_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "contact_scan_record_event_key" UNIQUE("raw_event_id")
);
--> statement-breakpoint
CREATE TABLE "contact_scan" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"scan_id" text NOT NULL,
	"generation" integer NOT NULL,
	"manifest" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "contact_scan_identity_key" UNIQUE("source_id","scan_id"),
	CONSTRAINT "contact_scan_generation_key" UNIQUE("source_id","generation"),
	CONSTRAINT "contact_scan_owner_key" UNIQUE("id","created_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "contact_source" (
	"id" text PRIMARY KEY NOT NULL,
	"epoch_id" text NOT NULL,
	"store_id" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "contact_source_identity_key" UNIQUE("epoch_id","store_id"),
	CONSTRAINT "contact_source_owner_key" UNIQUE("id","created_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"source_contact_id" text NOT NULL,
	"fields" jsonb NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"generation" integer NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "contact_identity_key" UNIQUE("source_id","source_contact_id"),
	CONSTRAINT "contact_owner_key" UNIQUE("id","created_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "data_domain_event" (
	"id" text PRIMARY KEY NOT NULL,
	"revision_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "data_domain_revision_key" UNIQUE("revision_id","event_type")
);
--> statement-breakpoint
ALTER TABLE "contact_revision" ADD CONSTRAINT "contact_revision_contact_fk" FOREIGN KEY ("contact_id","created_by_user_id") REFERENCES "public"."contact"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_revision" ADD CONSTRAINT "contact_revision_scan_fk" FOREIGN KEY ("scan_id","created_by_user_id") REFERENCES "public"."contact_scan"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_scan_record" ADD CONSTRAINT "contact_record_scan_fk" FOREIGN KEY ("scan_id","created_by_user_id") REFERENCES "public"."contact_scan"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_scan_record" ADD CONSTRAINT "contact_record_event_fk" FOREIGN KEY ("raw_event_id","created_by_user_id") REFERENCES "public"."data_event"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_scan" ADD CONSTRAINT "contact_scan_source_fk" FOREIGN KEY ("source_id","created_by_user_id") REFERENCES "public"."contact_source"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_source" ADD CONSTRAINT "contact_source_epoch_fk" FOREIGN KEY ("epoch_id","created_by_user_id") REFERENCES "public"."data_collection_epoch"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_source_owner_fk" FOREIGN KEY ("source_id","created_by_user_id") REFERENCES "public"."contact_source"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD CONSTRAINT "data_domain_revision_fk" FOREIGN KEY ("revision_id","created_by_user_id") REFERENCES "public"."contact_revision"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_scan_record_scan_idx" ON "contact_scan_record" USING btree ("scan_id");--> statement-breakpoint
CREATE INDEX "contact_scan_due_idx" ON "contact_scan" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "contact_owner_list_idx" ON "contact" USING btree ("created_by_user_id","id");--> statement-breakpoint
CREATE INDEX "data_domain_owner_idx" ON "data_domain_event" USING btree ("created_by_user_id","status","id");