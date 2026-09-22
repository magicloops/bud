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
	CONSTRAINT "browser_handoff_status_check" CHECK ("browser_handoff"."status" in ('pending','returned','canceled') and "browser_handoff"."kind" in ('agent','user','return_control')),
	CONSTRAINT "browser_handoff_actor_check" CHECK ("browser_handoff"."returned_by_user_id" is null or "browser_handoff"."returned_by_user_id" = "browser_handoff"."created_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "browser_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"bud_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"profile_generation" integer DEFAULT 1 NOT NULL,
	"control_state" text DEFAULT 'agent' NOT NULL,
	"private_content" boolean DEFAULT false NOT NULL,
	"control_epoch" integer DEFAULT 1 NOT NULL,
	"control_session_id" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"control_request_id" text,
	"control_operation" text,
	"desired_state" text DEFAULT 'open' NOT NULL,
	"lifecycle_request_id" text,
	"requested_by_user_id" text,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_resource_owner_key" UNIQUE("id","bud_id","created_by_user_id"),
	CONSTRAINT "browser_resource_control_check" CHECK ("browser_resource"."control_state" in ('agent','paused','human_private','resume_pending') and ("browser_resource"."control_state" <> 'agent' or not "browser_resource"."private_content") and ("browser_resource"."control_state" <> 'human_private' or ("browser_resource"."private_content" and "browser_resource"."control_session_id" is not null))),
	CONSTRAINT "browser_resource_operation_check" CHECK ("browser_resource"."control_operation" is null or "browser_resource"."control_operation" in ('pause','acquire','prepare_return','finish_return')),
	CONSTRAINT "browser_resource_state_check" CHECK ("browser_resource"."desired_state" in ('open','stop_pending','stopped','reset_pending') and ("browser_resource"."desired_state" not in ('stop_pending','reset_pending') or "browser_resource"."lifecycle_request_id" is not null)),
	CONSTRAINT "browser_resource_counters_check" CHECK ("browser_resource"."control_epoch" > 0 and "browser_resource"."revision" >= 0 and "browser_resource"."profile_generation" > 0),
	CONSTRAINT "browser_resource_actor_check" CHECK ("browser_resource"."requested_by_user_id" is null or "browser_resource"."requested_by_user_id" = "browser_resource"."created_by_user_id")
);
--> statement-breakpoint
CREATE TABLE "browser_session" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"bud_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"browser_id" text,
	"generation" text NOT NULL,
	"boot_id" text NOT NULL,
	"state" text DEFAULT 'opening' NOT NULL,
	"desired_state" text DEFAULT 'open' NOT NULL,
	"control_epoch" integer DEFAULT 1 NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"invocation_id" text,
	"invocation_fence" integer,
	"pending_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "browser_session_context_key" UNIQUE("id","thread_id","bud_id","created_by_user_id"),
	CONSTRAINT "browser_session_linked_check" CHECK ("browser_session"."closed_at" is not null or "browser_session"."browser_id" is not null),
	CONSTRAINT "browser_session_state_check" CHECK ("browser_session"."state" in ('opening','ready','interrupted','closed') and "browser_session"."desired_state" in ('open','closed')),
	CONSTRAINT "browser_session_counters_check" CHECK ("browser_session"."control_epoch" > 0 and "browser_session"."sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_invocation" ADD COLUMN "work_duration_ms" bigint;--> statement-breakpoint
ALTER TABLE "agent_invocation" ADD COLUMN "work_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "browser_handoff" ADD CONSTRAINT "browser_handoff_session_owner_fk" FOREIGN KEY ("session_id","thread_id","bud_id","created_by_user_id") REFERENCES "public"."browser_session"("id","thread_id","bud_id","created_by_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoff" ADD CONSTRAINT "browser_handoff_invocation_owner_fk" FOREIGN KEY ("invocation_id","thread_id","bud_id","created_by_user_id") REFERENCES "public"."agent_invocation"("id","thread_id","bud_id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_resource" ADD CONSTRAINT "browser_resource_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_session" ADD CONSTRAINT "browser_session_resource_owner_fk" FOREIGN KEY ("browser_id","bud_id","created_by_user_id") REFERENCES "public"."browser_resource"("id","bud_id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_session" ADD CONSTRAINT "browser_session_thread_owner_fk" FOREIGN KEY ("thread_id","bud_id","created_by_user_id") REFERENCES "public"."thread"("thread_id","bud_id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_handoff_pending_invocation_idx" ON "browser_handoff" USING btree ("invocation_id") WHERE "browser_handoff"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "browser_handoff_session_status_idx" ON "browser_handoff" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "browser_handoff_owner_idx" ON "browser_handoff" USING btree ("created_by_user_id","thread_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_resource_active_bud_idx" ON "browser_resource" USING btree ("bud_id") WHERE "browser_resource"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "browser_resource_owner_idx" ON "browser_resource" USING btree ("created_by_user_id","bud_id");--> statement-breakpoint
CREATE INDEX "browser_resource_pending_idx" ON "browser_resource" USING btree ("desired_state","updated_at");--> statement-breakpoint
CREATE INDEX "browser_session_resource_idx" ON "browser_session" USING btree ("browser_id","closed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_session_active_thread_idx" ON "browser_session" USING btree ("thread_id") WHERE "browser_session"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "browser_session_owner_idx" ON "browser_session" USING btree ("created_by_user_id","bud_id");--> statement-breakpoint
CREATE INDEX "browser_session_cleanup_idx" ON "browser_session" USING btree ("bud_id","desired_state","closed_at");