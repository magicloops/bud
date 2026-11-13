CREATE TABLE "data_installation_source_state" (
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"installation_id" text NOT NULL,
	"source" text NOT NULL,
	"permission" text NOT NULL,
	"level" text,
	"caveats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asked_at" timestamp with time zone,
	"reported_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_installation_source_state_pk" PRIMARY KEY("created_by_user_id","installation_id","source"),
	CONSTRAINT "data_installation_source_state_source_check" CHECK ("data_installation_source_state"."source" in ('location', 'health', 'contacts')),
	CONSTRAINT "data_installation_source_state_permission_check" CHECK ("data_installation_source_state"."permission" in ('not_asked', 'granted', 'denied', 'restricted', 'unknowable'))
);
--> statement-breakpoint
CREATE TABLE "data_source_setting_history" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"source" text NOT NULL,
	"enabled" boolean NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_source_setting" (
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"source" text NOT NULL,
	"enabled" boolean NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" text NOT NULL,
	CONSTRAINT "data_source_setting_pk" PRIMARY KEY("created_by_user_id","source"),
	CONSTRAINT "data_source_setting_source_check" CHECK ("data_source_setting"."source" in ('location', 'health', 'contacts'))
);
--> statement-breakpoint
ALTER TABLE "data_installation_source_state" ADD CONSTRAINT "data_installation_source_state_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_setting_history" ADD CONSTRAINT "data_source_setting_history_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_setting" ADD CONSTRAINT "data_source_setting_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_source_setting_history_owner_idx" ON "data_source_setting_history" USING btree ("created_by_user_id","source","changed_at");--> statement-breakpoint
-- Existing accounts: a source is on where the account already has stored data for it. Everything
-- else, and every new account, starts off.
INSERT INTO "data_source_setting" ("created_by_user_id", "source", "enabled", "changed_by")
SELECT DISTINCT "created_by_user_id", 'location', true, 'migration' FROM "location_observation"
UNION SELECT DISTINCT "created_by_user_id", 'health', true, 'migration' FROM "health_workout"
UNION SELECT DISTINCT "created_by_user_id", 'health', true, 'migration' FROM "health_sleep_segment"
UNION SELECT DISTINCT "created_by_user_id", 'contacts', true, 'migration' FROM "contact_scan"
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "data_source_setting_history" ("id", "created_by_user_id", "source", "enabled", "changed_at", "changed_by")
SELECT "created_by_user_id" || ':' || "source" || ':migration', "created_by_user_id", "source", "enabled", "changed_at", "changed_by"
FROM "data_source_setting" WHERE "changed_by" = 'migration' ON CONFLICT DO NOTHING;
