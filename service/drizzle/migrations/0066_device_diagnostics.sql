CREATE TABLE "device_diagnostic_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by_user_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"journal_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"launch_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"uptime" double precision,
	"app_state" text NOT NULL,
	"area" text NOT NULL,
	"level" smallint NOT NULL,
	"event" text NOT NULL,
	"fields" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_diagnostic_entry_seq_key" UNIQUE("created_by_user_id","installation_id","journal_id","seq"),
	CONSTRAINT "device_diagnostic_entry_level_check" CHECK ("device_diagnostic_entry"."level" between 0 and 4)
);
--> statement-breakpoint
CREATE TABLE "device_diagnostic_launch" (
	"created_by_user_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"app_version" text,
	"build" text,
	"os" text,
	"device" text,
	"bundle_id" text,
	"environment" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_diagnostic_launch_pk" PRIMARY KEY("created_by_user_id","installation_id","id")
);
--> statement-breakpoint
ALTER TABLE "device_diagnostic_entry" ADD CONSTRAINT "device_diagnostic_entry_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_diagnostic_launch" ADD CONSTRAINT "device_diagnostic_launch_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_diagnostic_entry_owner_at_idx" ON "device_diagnostic_entry" USING btree ("created_by_user_id","at");--> statement-breakpoint
CREATE INDEX "device_diagnostic_entry_owner_area_at_idx" ON "device_diagnostic_entry" USING btree ("created_by_user_id","area","at");--> statement-breakpoint
CREATE INDEX "device_diagnostic_entry_fields_idx" ON "device_diagnostic_entry" USING gin ("fields" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "device_diagnostic_launch_owner_at_idx" ON "device_diagnostic_launch" USING btree ("created_by_user_id","at");