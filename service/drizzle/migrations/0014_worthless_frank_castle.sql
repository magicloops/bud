CREATE TABLE "proxy_session" (
	"proxy_session_id" text PRIMARY KEY NOT NULL,
	"bud_id" text NOT NULL,
	"thread_id" uuid,
	"operation_id" text,
	"active_stream_id" text,
	"target_host" text NOT NULL,
	"target_port" integer NOT NULL,
	"allowed_methods" jsonb DEFAULT '["GET","HEAD"]'::jsonb NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"display_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audit_correlation_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"revoke_reason" text,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proxy_session" ADD CONSTRAINT "proxy_session_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_session" ADD CONSTRAINT "proxy_session_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_session" ADD CONSTRAINT "proxy_session_operation_id_bud_operation_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."bud_operation"("operation_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_session" ADD CONSTRAINT "proxy_session_active_stream_id_bud_stream_stream_id_fk" FOREIGN KEY ("active_stream_id") REFERENCES "public"."bud_stream"("stream_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_session" ADD CONSTRAINT "proxy_session_revoked_by_user_id_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proxy_session_owner_state_idx" ON "proxy_session" USING btree ("created_by_user_id","state","expires_at");--> statement-breakpoint
CREATE INDEX "proxy_session_bud_state_idx" ON "proxy_session" USING btree ("bud_id","state","expires_at");--> statement-breakpoint
CREATE INDEX "proxy_session_thread_idx" ON "proxy_session" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "proxy_session_audit_correlation_idx" ON "proxy_session" USING btree ("audit_correlation_id");