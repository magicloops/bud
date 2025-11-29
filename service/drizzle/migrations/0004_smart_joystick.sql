CREATE TABLE "bud_terminal" (
	"bud_id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'none' NOT NULL,
	"tmux_session_name" text,
	"pid" integer,
	"shell" text,
	"cols" integer DEFAULT 200 NOT NULL,
	"rows" integer DEFAULT 50 NOT NULL,
	"started_at" timestamp with time zone,
	"last_input_at" timestamp with time zone,
	"last_output_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"output_log_bytes" bigint DEFAULT 0 NOT NULL,
	"total_input_bytes" bigint DEFAULT 0 NOT NULL,
	"total_output_bytes" bigint DEFAULT 0 NOT NULL,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminal_input_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bud_id" text NOT NULL,
	"data" "bytea" NOT NULL,
	"source" text NOT NULL,
	"run_id" text,
	"user_id" text,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminal_output" (
	"bud_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"data" "bytea" NOT NULL,
	"byte_offset" bigint NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terminal_output_pkey" PRIMARY KEY("bud_id","seq")
);
--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "hard_ttl_sec" SET DEFAULT 31536000;--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "idle_kill_sec" SET DEFAULT 31536000;--> statement-breakpoint
ALTER TABLE "bud_terminal" ADD CONSTRAINT "bud_terminal_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_input_log" ADD CONSTRAINT "terminal_input_log_bud_id_bud_terminal_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud_terminal"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_output" ADD CONSTRAINT "terminal_output_bud_id_bud_terminal_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud_terminal"("bud_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bud_terminal_state_idx" ON "bud_terminal" USING btree ("state");--> statement-breakpoint
CREATE INDEX "bud_terminal_last_activity_idx" ON "bud_terminal" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX "terminal_input_log_bud_idx" ON "terminal_input_log" USING btree ("bud_id","created_at");--> statement-breakpoint
CREATE INDEX "terminal_output_offset_idx" ON "terminal_output" USING btree ("bud_id","byte_offset");
