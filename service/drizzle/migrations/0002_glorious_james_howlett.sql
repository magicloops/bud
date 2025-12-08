CREATE TABLE "session_log" (
	"session_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"stream" text DEFAULT 'pty',
	"data" "bytea" NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_log_pkey" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"session_id" text PRIMARY KEY NOT NULL,
	"bud_id" text NOT NULL,
	"thread_id" uuid,
	"backend" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now(),
	"finished_at" timestamp with time zone,
	"exit_code" integer,
	"signal" text,
	"bytes_out" bigint DEFAULT 0 NOT NULL,
	"writer_user_id" text,
	"hard_ttl_sec" integer DEFAULT 43200 NOT NULL,
	"idle_kill_sec" integer DEFAULT 1200 NOT NULL,
	"logs_bytes" bigint DEFAULT 0 NOT NULL,
	"log_truncated" boolean DEFAULT false NOT NULL,
	"logs_blob_url" text,
	"last_activity_at" timestamp with time zone,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bud" ALTER COLUMN "capabilities" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "session_log" ADD CONSTRAINT "session_log_session_id_session_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_log_created_idx" ON "session_log" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "session_bud_idx" ON "session" USING btree ("bud_id","started_at");--> statement-breakpoint
CREATE INDEX "session_thread_idx" ON "session" USING btree ("thread_id","started_at");