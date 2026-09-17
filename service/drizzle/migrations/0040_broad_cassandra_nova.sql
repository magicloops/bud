ALTER TABLE "browser_session" ADD CONSTRAINT "browser_session_context_key" UNIQUE("id","thread_id","bud_id","created_by_user_id");--> statement-breakpoint
CREATE TABLE "browser_handoff" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"bud_id" text NOT NULL,
	"invocation_id" text,
	"call_id" text,
	"client_id" uuid,
	"reason" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"returned_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "browser_handoff_call_key" UNIQUE("invocation_id","call_id"),
	CONSTRAINT "browser_handoff_status_check" CHECK ("browser_handoff"."status" in ('pending','returned','canceled') and "browser_handoff"."kind" in ('agent','user')),
	CONSTRAINT "browser_handoff_actor_check" CHECK ("browser_handoff"."returned_by_user_id" is null or "browser_handoff"."returned_by_user_id" = "browser_handoff"."created_by_user_id")
);
--> statement-breakpoint
ALTER TABLE "browser_session" ADD COLUMN "control_state" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_session" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_session" ADD COLUMN "control_request_id" text;--> statement-breakpoint
ALTER TABLE "browser_handoff" ADD CONSTRAINT "browser_handoff_session_owner_fk" FOREIGN KEY ("session_id","thread_id","bud_id","created_by_user_id") REFERENCES "public"."browser_session"("id","thread_id","bud_id","created_by_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoff" ADD CONSTRAINT "browser_handoff_invocation_owner_fk" FOREIGN KEY ("invocation_id","thread_id","bud_id","created_by_user_id") REFERENCES "public"."agent_invocation"("id","thread_id","bud_id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_handoff_pending_session_idx" ON "browser_handoff" USING btree ("session_id") WHERE "browser_handoff"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "browser_handoff_owner_idx" ON "browser_handoff" USING btree ("created_by_user_id","thread_id","status");--> statement-breakpoint
ALTER TABLE "browser_session" ADD CONSTRAINT "browser_session_control_check" CHECK ("browser_session"."control_state" in ('agent','paused','human_private','resume_pending') and "browser_session"."revision" >= 0);