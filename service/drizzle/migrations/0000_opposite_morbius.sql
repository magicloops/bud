CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE TABLE "bud" (
	"bud_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"os" text NOT NULL,
	"arch" text NOT NULL,
	"version" text,
	"status" text DEFAULT 'offline' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"device_secret" text,
	"device_pubkey" text,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollment_token" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message" (
	"message_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_log" (
	"run_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"stream" text NOT NULL,
	"data" "bytea" NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_log_pkey" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "run_step" (
	"step_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"idx" integer NOT NULL,
	"tool" text NOT NULL,
	"args_json" jsonb NOT NULL,
	"tool_meta_json" jsonb,
	"exit_code" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run" (
	"run_id" text PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"step_count" integer DEFAULT 0 NOT NULL,
	"logs_bytes" bigint DEFAULT 0 NOT NULL,
	"log_truncated" boolean DEFAULT false NOT NULL,
	"logs_blob_url" text,
	"workspace_path" text,
	"canceled" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"canceled_by_user_id" text,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread" (
	"thread_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bud_id" text NOT NULL,
	"title" text,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_log" ADD CONSTRAINT "run_log_run_id_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_step" ADD CONSTRAINT "run_step_run_id_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_thread_idx" ON "message" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "run_log_stream_idx" ON "run_log" USING btree ("run_id","stream","seq");--> statement-breakpoint
CREATE INDEX "run_step_run_idx" ON "run_step" USING btree ("run_id","idx");--> statement-breakpoint
CREATE INDEX "run_thread_idx" ON "run" USING btree ("thread_id","started_at");--> statement-breakpoint
CREATE INDEX "thread_bud_idx" ON "thread" USING btree ("bud_id");
