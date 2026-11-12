CREATE TABLE "agent_data_grant_history" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"version" integer NOT NULL,
	"scopes" jsonb NOT NULL,
	"contact_fields" jsonb NOT NULL,
	"health_types" jsonb NOT NULL,
	"history_days" integer NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_data_grant_history_version_key" UNIQUE("created_by_user_id","version")
);
--> statement-breakpoint
CREATE TABLE "data_access_log" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_ref" text NOT NULL,
	"thread_id" text,
	"turn_id" text,
	"source" text NOT NULL,
	"operation" text NOT NULL,
	"window_from" timestamp with time zone,
	"window_to" timestamp with time zone,
	"record_count" integer,
	"policy_version" integer,
	"outcome" text DEFAULT 'ok' NOT NULL,
	CONSTRAINT "data_access_log_actor_check" CHECK ("data_access_log"."actor_kind" in ('agent', 'automation', 'app', 'processor')),
	CONSTRAINT "data_access_log_source_check" CHECK ("data_access_log"."source" in ('location', 'health', 'contacts'))
);
--> statement-breakpoint
ALTER TABLE "agent_data_grant_history" ADD CONSTRAINT "agent_data_grant_history_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_access_log" ADD CONSTRAINT "data_access_log_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_data_grant_history_owner_idx" ON "agent_data_grant_history" USING btree ("created_by_user_id","changed_at");--> statement-breakpoint
CREATE INDEX "data_access_log_source_idx" ON "data_access_log" USING btree ("created_by_user_id","source","at");--> statement-breakpoint
CREATE INDEX "data_access_log_actor_idx" ON "data_access_log" USING btree ("created_by_user_id","actor_kind","actor_ref","at");--> statement-breakpoint
-- Existing accounts: the agent's current permission is the first entry in its history, so the
-- next change has something to be compared with.
INSERT INTO "agent_data_grant_history" ("id", "created_by_user_id", "tenant_id", "version", "scopes", "contact_fields", "health_types", "history_days", "changed_at")
SELECT "created_by_user_id" || ':' || "version" || ':migration', "created_by_user_id", "tenant_id", "version", "scopes", "contact_fields", "health_types", "history_days", "updated_at"
FROM "agent_data_grant" ON CONFLICT DO NOTHING;
