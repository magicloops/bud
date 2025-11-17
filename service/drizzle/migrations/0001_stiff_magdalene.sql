CREATE TABLE "run_summary" (
	"run_id" text PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"bud_id" text NOT NULL,
	"status" text NOT NULL,
	"exit_code" integer,
	"stdout_bytes" bigint DEFAULT 0 NOT NULL,
	"stderr_bytes" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bud" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "bud" ADD COLUMN "accent_color" text;--> statement-breakpoint
ALTER TABLE "bud" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bud" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "display_role" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "last_message_preview" text;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "message_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "run_summary" ADD CONSTRAINT "run_summary_run_id_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_summary" ADD CONSTRAINT "run_summary_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_summary" ADD CONSTRAINT "run_summary_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_summary_bud_idx" ON "run_summary" USING btree ("bud_id","started_at");--> statement-breakpoint
CREATE INDEX "run_summary_thread_idx" ON "run_summary" USING btree ("thread_id","started_at");