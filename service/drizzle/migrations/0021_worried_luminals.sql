CREATE TABLE "agent_context_checkpoint" (
	"checkpoint_id" text PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"reason" text NOT NULL,
	"phase" text NOT NULL,
	"implementation" text DEFAULT 'local_summary' NOT NULL,
	"status" text NOT NULL,
	"source_provider" text,
	"source_model" text,
	"source_reasoning_effort" text,
	"summary" text,
	"replacement_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compacted_through_message_created_at" timestamp with time zone,
	"compacted_through_message_id" uuid,
	"compacted_through_llm_call_created_at" timestamp with time zone,
	"compacted_through_llm_call_id" text,
	"input_tokens_before" integer,
	"estimated_tokens_after" integer,
	"error" jsonb,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_context_checkpoint" ADD CONSTRAINT "agent_context_checkpoint_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_context_checkpoint_thread_status_created_idx" ON "agent_context_checkpoint" USING btree ("thread_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_context_checkpoint_message_boundary_idx" ON "agent_context_checkpoint" USING btree ("thread_id","compacted_through_message_created_at","compacted_through_message_id");--> statement-breakpoint
CREATE INDEX "agent_context_checkpoint_llm_boundary_idx" ON "agent_context_checkpoint" USING btree ("thread_id","compacted_through_llm_call_created_at","compacted_through_llm_call_id");