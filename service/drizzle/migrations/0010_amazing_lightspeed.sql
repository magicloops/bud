-- Catch up the checked-in migration chain to the current schema.
-- Existing message rows are backfilled in SQL here because migration files
-- cannot call the service's TypeScript UUIDv7 helper.
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "client_id" uuid;--> statement-breakpoint
UPDATE "message" SET "client_id" = gen_random_uuid() WHERE "client_id" IS NULL;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "client_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "message_client_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "message_client_id_idx" ON "message" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "terminal_session" DROP COLUMN IF EXISTS "tmux_session_name";
