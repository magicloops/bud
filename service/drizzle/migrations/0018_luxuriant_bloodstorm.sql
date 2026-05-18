CREATE TABLE "proxied_site" (
	"proxied_site_id" text PRIMARY KEY NOT NULL,
	"bud_id" text NOT NULL,
	"operation_id" text,
	"active_stream_id" text,
	"display_name" text NOT NULL,
	"slug" text NOT NULL,
	"endpoint_host" text NOT NULL,
	"target_scheme" text DEFAULT 'http' NOT NULL,
	"target_host" text NOT NULL,
	"target_port" integer NOT NULL,
	"default_path" text DEFAULT '/' NOT NULL,
	"access_policy" text DEFAULT 'private_owner' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by_user_id" text,
	"disable_reason" text,
	"display_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audit_correlation_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"last_renewed_at" timestamp with time zone,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proxied_site_viewer_grant" (
	"viewer_grant_id" text PRIMARY KEY NOT NULL,
	"proxied_site_id" text NOT NULL,
	"bud_id" text NOT NULL,
	"user_id" text NOT NULL,
	"auth_session_id" text,
	"grant_hash" text NOT NULL,
	"redirect_path" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proxied_site_viewer_session" (
	"viewer_session_id" text PRIMARY KEY NOT NULL,
	"proxied_site_id" text NOT NULL,
	"bud_id" text NOT NULL,
	"user_id" text NOT NULL,
	"auth_session_id" text,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_web_view" (
	"thread_id" uuid NOT NULL,
	"bud_id" text NOT NULL,
	"proxied_site_id" text NOT NULL,
	"selected_path" text,
	"attached_by_user_id" text,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_web_view_pkey" PRIMARY KEY("thread_id")
);
--> statement-breakpoint
ALTER TABLE "proxied_site" ADD CONSTRAINT "proxied_site_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxied_site" ADD CONSTRAINT "proxied_site_operation_id_bud_operation_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."bud_operation"("operation_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxied_site" ADD CONSTRAINT "proxied_site_active_stream_id_bud_stream_stream_id_fk" FOREIGN KEY ("active_stream_id") REFERENCES "public"."bud_stream"("stream_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxied_site" ADD CONSTRAINT "proxied_site_disabled_by_user_id_user_id_fk" FOREIGN KEY ("disabled_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxied_site_viewer_grant" ADD CONSTRAINT "proxied_site_viewer_grant_proxied_site_id_proxied_site_proxied_site_id_fk" FOREIGN KEY ("proxied_site_id") REFERENCES "public"."proxied_site"("proxied_site_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxied_site_viewer_grant" ADD CONSTRAINT "proxied_site_viewer_grant_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxied_site_viewer_grant" ADD CONSTRAINT "proxied_site_viewer_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxied_site_viewer_grant" ADD CONSTRAINT "proxied_site_viewer_grant_auth_session_id_session_id_fk" FOREIGN KEY ("auth_session_id") REFERENCES "auth"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxied_site_viewer_session" ADD CONSTRAINT "proxied_site_viewer_session_proxied_site_id_proxied_site_proxied_site_id_fk" FOREIGN KEY ("proxied_site_id") REFERENCES "public"."proxied_site"("proxied_site_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxied_site_viewer_session" ADD CONSTRAINT "proxied_site_viewer_session_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxied_site_viewer_session" ADD CONSTRAINT "proxied_site_viewer_session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxied_site_viewer_session" ADD CONSTRAINT "proxied_site_viewer_session_auth_session_id_session_id_fk" FOREIGN KEY ("auth_session_id") REFERENCES "auth"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_web_view" ADD CONSTRAINT "thread_web_view_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_web_view" ADD CONSTRAINT "thread_web_view_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_web_view" ADD CONSTRAINT "thread_web_view_proxied_site_id_proxied_site_proxied_site_id_fk" FOREIGN KEY ("proxied_site_id") REFERENCES "public"."proxied_site"("proxied_site_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_web_view" ADD CONSTRAINT "thread_web_view_attached_by_user_id_user_id_fk" FOREIGN KEY ("attached_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proxied_site_endpoint_host_idx" ON "proxied_site" USING btree ("endpoint_host");--> statement-breakpoint
CREATE INDEX "proxied_site_owner_idx" ON "proxied_site" USING btree ("created_by_user_id","bud_id");--> statement-breakpoint
CREATE INDEX "proxied_site_bud_enabled_idx" ON "proxied_site" USING btree ("bud_id","enabled","expires_at");--> statement-breakpoint
CREATE INDEX "proxied_site_reuse_idx" ON "proxied_site" USING btree ("bud_id","created_by_user_id","target_host","target_port","default_path");--> statement-breakpoint
CREATE INDEX "proxied_site_audit_correlation_idx" ON "proxied_site" USING btree ("audit_correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proxied_site_viewer_grant_hash_idx" ON "proxied_site_viewer_grant" USING btree ("grant_hash");--> statement-breakpoint
CREATE INDEX "proxied_site_viewer_grant_site_idx" ON "proxied_site_viewer_grant" USING btree ("proxied_site_id","expires_at");--> statement-breakpoint
CREATE INDEX "proxied_site_viewer_grant_user_idx" ON "proxied_site_viewer_grant" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "proxied_site_viewer_session_token_idx" ON "proxied_site_viewer_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "proxied_site_viewer_session_site_user_idx" ON "proxied_site_viewer_session" USING btree ("proxied_site_id","user_id","expires_at");--> statement-breakpoint
CREATE INDEX "proxied_site_viewer_session_auth_session_idx" ON "proxied_site_viewer_session" USING btree ("auth_session_id");--> statement-breakpoint
CREATE INDEX "thread_web_view_site_idx" ON "thread_web_view" USING btree ("proxied_site_id","updated_at");--> statement-breakpoint
CREATE INDEX "thread_web_view_owner_idx" ON "thread_web_view" USING btree ("created_by_user_id","updated_at");