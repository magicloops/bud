CREATE TABLE "terminal_command" (
	"command_id" text PRIMARY KEY NOT NULL,
	"terminal_session_id" text NOT NULL,
	"thread_id" uuid,
	"bud_id" text NOT NULL,
	"created_by_user_id" text,
	"tenant_id" text,
	"command_started_at" timestamp with time zone NOT NULL,
	"command_finished_at" timestamp with time zone,
	"exit_code" integer,
	"output_byte_start" bigint DEFAULT 0 NOT NULL,
	"output_byte_end" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "terminal_session_output_seq_idx";--> statement-breakpoint
ALTER TABLE "terminal_command" ADD CONSTRAINT "terminal_command_session_fk" FOREIGN KEY ("terminal_session_id") REFERENCES "public"."terminal_session"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "terminal_command_session_idx" ON "terminal_command" USING btree ("terminal_session_id","command_started_at");--> statement-breakpoint
CREATE INDEX "terminal_command_thread_idx" ON "terminal_command" USING btree ("thread_id","command_started_at");--> statement-breakpoint
CREATE INDEX "terminal_command_bud_idx" ON "terminal_command" USING btree ("bud_id");--> statement-breakpoint
ALTER TABLE "terminal_session_output" DROP COLUMN "seq";