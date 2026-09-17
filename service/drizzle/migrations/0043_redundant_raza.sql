ALTER TABLE "agent_invocation" ADD COLUMN "work_duration_ms" bigint;--> statement-breakpoint
ALTER TABLE "agent_invocation" ADD COLUMN "work_started_at" timestamp with time zone;