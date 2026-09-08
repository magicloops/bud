ALTER TABLE "message" ADD CONSTRAINT "message_invocation_owner_key" UNIQUE("message_id","thread_id","created_by_user_id");--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_invocation_owner_key" UNIQUE("thread_id","bud_id","created_by_user_id");--> statement-breakpoint
CREATE TABLE "agent_invocation_action" (
	"id" text PRIMARY KEY NOT NULL,
	"invocation_id" text NOT NULL,
	"call_id" text NOT NULL,
	"fence" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'intent' NOT NULL,
	"evidence" jsonb,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_invocation_action_call_key" UNIQUE("invocation_id","call_id")
);--> statement-breakpoint
CREATE TABLE "agent_invocation" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"bud_id" text NOT NULL,
	"input_message_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"model" text NOT NULL,
	"reasoning_effort" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"fence" integer DEFAULT 0 NOT NULL,
	"worker_id" text,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latest_start_at" timestamp with time zone,
	"outcome_code" text,
	"cancel_requested_at" timestamp with time zone,
	"canceled_by_user_id" text,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_invocation_owner_key" UNIQUE("id","created_by_user_id"),
	CONSTRAINT "agent_invocation_dedupe_key" UNIQUE("created_by_user_id","idempotency_key"),
	CONSTRAINT "agent_invocation_input_key" UNIQUE("input_message_id"),
	CONSTRAINT "agent_invocation_turn_key" UNIQUE("turn_id"),
	CONSTRAINT "agent_invocation_status_check" CHECK ("agent_invocation"."status" in ('pending','retry_wait','leased','waiting_for_bud','waiting_for_model','running','waiting_for_user','succeeded','failed','canceled','expired','needs_review')),
	CONSTRAINT "agent_invocation_origin_check" CHECK ("agent_invocation"."origin" in ('human','automation')),
	CONSTRAINT "agent_invocation_lease_check" CHECK (("agent_invocation"."status" in ('leased','running')) = ("agent_invocation"."worker_id" is not null and "agent_invocation"."lease_expires_at" is not null))
);--> statement-breakpoint
ALTER TABLE "agent_invocation_action" ADD CONSTRAINT "agent_action_invocation_owner_fk" FOREIGN KEY ("invocation_id","created_by_user_id") REFERENCES "public"."agent_invocation"("id","created_by_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_invocation" ADD CONSTRAINT "agent_invocation_canceled_by_user_id_user_id_fk" FOREIGN KEY ("canceled_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_invocation" ADD CONSTRAINT "agent_invocation_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_invocation" ADD CONSTRAINT "agent_invocation_thread_owner_fk" FOREIGN KEY ("thread_id","bud_id","created_by_user_id") REFERENCES "public"."thread"("thread_id","bud_id","created_by_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_invocation" ADD CONSTRAINT "agent_invocation_input_owner_fk" FOREIGN KEY ("input_message_id","thread_id","created_by_user_id") REFERENCES "public"."message"("message_id","thread_id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_invocation_active_thread_idx" ON "agent_invocation" USING btree ("thread_id") WHERE "agent_invocation"."status" in ('leased', 'running', 'waiting_for_user', 'needs_review');--> statement-breakpoint
CREATE INDEX "agent_invocation_due_idx" ON "agent_invocation" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "agent_invocation_owner_idx" ON "agent_invocation" USING btree ("created_by_user_id","created_at");
