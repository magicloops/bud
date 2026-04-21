DROP TABLE "run_log" CASCADE;--> statement-breakpoint
DROP TABLE "run_step" CASCADE;--> statement-breakpoint
DROP TABLE "run_summary" CASCADE;--> statement-breakpoint
DROP TABLE "run" CASCADE;--> statement-breakpoint
ALTER TABLE "terminal_session_input_log" DROP COLUMN "run_id";