CREATE TABLE "google_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"oauth_client_id" text NOT NULL,
	"account_subject" text,
	"account_email" text,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text NOT NULL,
	"encrypted_credentials" text,
	"oauth_state_hash" text,
	"oauth_session_hash" text,
	"oauth_expires_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_connection_owner_key" UNIQUE("created_by_user_id"),
	CONSTRAINT "google_connection_status_check" CHECK ("google_connection"."status" in ('connecting','connected','reconnect_required','disconnected')),
	CONSTRAINT "google_connection_credentials_check" CHECK ("google_connection"."status" <> 'disconnected' or "google_connection"."encrypted_credentials" is null),
	CONSTRAINT "google_connection_flow_check" CHECK (("google_connection"."oauth_state_hash" is null and "google_connection"."oauth_session_hash" is null and "google_connection"."oauth_expires_at" is null) or ("google_connection"."oauth_state_hash" is not null and "google_connection"."oauth_session_hash" is not null and "google_connection"."oauth_expires_at" is not null and "google_connection"."status" = 'connecting'))
);
--> statement-breakpoint
ALTER TABLE "google_connection" ADD CONSTRAINT "google_connection_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_connection_oauth_state_idx" ON "google_connection" USING btree ("oauth_state_hash");