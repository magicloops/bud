ALTER TABLE "browser_handoff" DROP CONSTRAINT "browser_handoff_status_check";--> statement-breakpoint
DROP INDEX "browser_handoff_pending_session_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "browser_handoff_pending_invocation_idx" ON "browser_handoff" USING btree ("invocation_id") WHERE "browser_handoff"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "browser_handoff_session_status_idx" ON "browser_handoff" USING btree ("session_id","status");--> statement-breakpoint
ALTER TABLE "browser_handoff" ADD CONSTRAINT "browser_handoff_status_check" CHECK ("browser_handoff"."status" in ('pending','returned','canceled') and "browser_handoff"."kind" in ('agent','user','return_control'));