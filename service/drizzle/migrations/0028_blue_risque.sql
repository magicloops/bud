DROP INDEX "agent_invocation_active_thread_idx";--> statement-breakpoint
ALTER TABLE "agent_invocation" ADD COLUMN "reserves_thread" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "agent_invocation" SET "reserves_thread" = true
WHERE "status" IN ('leased', 'running', 'waiting_for_user', 'needs_review')
OR EXISTS (SELECT 1 FROM "agent_invocation_action" a WHERE a."invocation_id" = "agent_invocation"."id" AND a."status" = 'waiting_for_user');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_invocation_active_thread_idx" ON "agent_invocation" USING btree ("thread_id") WHERE "agent_invocation"."reserves_thread";