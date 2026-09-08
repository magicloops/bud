ALTER TABLE "agent_invocation" ADD CONSTRAINT "agent_invocation_app_data_context_key" UNIQUE("id","thread_id","bud_id","created_by_user_id");
--> statement-breakpoint
ALTER TABLE "proxied_site" ADD CONSTRAINT "proxied_site_app_data_owner_key" UNIQUE("proxied_site_id","bud_id","created_by_user_id");
--> statement-breakpoint
CREATE TABLE "data_access_request" (
	"id" text PRIMARY KEY NOT NULL,
	"invocation_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"bud_id" text NOT NULL,
	"call_id" text NOT NULL,
	"proxied_site_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"decision_request" jsonb,
	"decision_idempotency_key" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_access_request_owner_key" UNIQUE("id","created_by_user_id"),
	CONSTRAINT "data_access_request_call_key" UNIQUE("invocation_id","call_id"),
	CONSTRAINT "data_access_request_decision_key" UNIQUE("created_by_user_id","decision_idempotency_key"),
	CONSTRAINT "data_access_request_state_check" CHECK ("data_access_request"."status" in ('pending','approved','declined','canceled','expired') and "data_access_request"."version" >= 0),
	CONSTRAINT "data_access_request_decision_check" CHECK (("data_access_request"."status" in ('approved','declined')) = ("data_access_request"."decision_request" is not null and "data_access_request"."decision_idempotency_key" is not null and "data_access_request"."decided_by_user_id" is not null and "data_access_request"."decided_at" is not null)),
	CONSTRAINT "data_access_request_actor_check" CHECK ("data_access_request"."decided_by_user_id" is null or "data_access_request"."decided_by_user_id" = "data_access_request"."created_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "data_app_key" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"verification_hash" text NOT NULL,
	"status" text DEFAULT 'handoff_pending' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"encrypted_envelope" jsonb,
	"ciphertext_digest" text NOT NULL,
	"setup_expires_at" timestamp with time zone NOT NULL,
	"installed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"revoke_request" jsonb,
	"outcome_code" text,
	"last_used_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_app_key_request_key" UNIQUE("request_id"),
	CONSTRAINT "data_app_key_state_check" CHECK ("data_app_key"."status" in ('handoff_pending','installed','revoked','setup_failed') and "data_app_key"."version" >= 0),
	CONSTRAINT "data_app_key_envelope_check" CHECK (("data_app_key"."status" = 'handoff_pending') = ("data_app_key"."encrypted_envelope" is not null)),
	CONSTRAINT "data_app_key_installed_check" CHECK ("data_app_key"."status" <> 'installed' or "data_app_key"."installed_at" is not null),
	CONSTRAINT "data_app_key_revoked_check" CHECK (("data_app_key"."status" in ('revoked','setup_failed')) = ("data_app_key"."revoked_at" is not null)),
	CONSTRAINT "data_app_key_actor_check" CHECK ("data_app_key"."revoked_by_user_id" is null or "data_app_key"."revoked_by_user_id" = "data_app_key"."created_by_user_id")
);
--> statement-breakpoint
ALTER TABLE "data_access_request" ADD CONSTRAINT "data_access_request_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "data_access_request" ADD CONSTRAINT "data_access_request_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "data_access_request" ADD CONSTRAINT "data_access_request_invocation_fk" FOREIGN KEY ("invocation_id","thread_id","bud_id","created_by_user_id") REFERENCES "public"."agent_invocation"("id","thread_id","bud_id","created_by_user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "data_access_request" ADD CONSTRAINT "data_access_request_action_fk" FOREIGN KEY ("invocation_id","call_id") REFERENCES "public"."agent_invocation_action"("invocation_id","call_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "data_access_request" ADD CONSTRAINT "data_access_request_site_fk" FOREIGN KEY ("proxied_site_id","bud_id","created_by_user_id") REFERENCES "public"."proxied_site"("proxied_site_id","bud_id","created_by_user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "data_app_key" ADD CONSTRAINT "data_app_key_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "data_app_key" ADD CONSTRAINT "data_app_key_request_owner_fk" FOREIGN KEY ("request_id","created_by_user_id") REFERENCES "public"."data_access_request"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "data_access_request_owner_idx" ON "data_access_request" USING btree ("created_by_user_id","status","id");
--> statement-breakpoint
CREATE INDEX "data_access_request_expiry_idx" ON "data_access_request" USING btree ("status","expires_at");
--> statement-breakpoint
CREATE INDEX "data_app_key_owner_idx" ON "data_app_key" USING btree ("created_by_user_id","status","id");
--> statement-breakpoint
CREATE INDEX "data_app_key_expiry_idx" ON "data_app_key" USING btree ("status","setup_expires_at");
