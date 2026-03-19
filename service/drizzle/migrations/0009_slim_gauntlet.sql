ALTER TABLE "terminal_session" DROP CONSTRAINT IF EXISTS "terminal_session_thread_id_unique";--> statement-breakpoint
ALTER TABLE "terminal_session" DROP CONSTRAINT IF EXISTS "terminal_session_thread_id_key";--> statement-breakpoint
DROP INDEX IF EXISTS "terminal_session_thread_active_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "terminal_session_thread_active_unique_idx" ON "terminal_session" USING btree ("thread_id") WHERE "terminal_session"."thread_id" is not null and "terminal_session"."closed_at" is null;
