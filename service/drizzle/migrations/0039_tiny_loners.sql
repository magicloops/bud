CREATE TABLE "browser_session" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"bud_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"generation" text NOT NULL,
	"boot_id" text NOT NULL,
	"profile_mode" text DEFAULT 'ephemeral' NOT NULL,
	"state" text DEFAULT 'opening' NOT NULL,
	"desired_state" text DEFAULT 'open' NOT NULL,
	"control_epoch" integer DEFAULT 1 NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"invocation_id" text,
	"invocation_fence" integer,
	"pending_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "browser_session_state_check" CHECK ("browser_session"."state" in ('opening','ready','interrupted','closed') and "browser_session"."desired_state" in ('open','closed') and "browser_session"."profile_mode" = 'ephemeral'),
	CONSTRAINT "browser_session_counters_check" CHECK ("browser_session"."control_epoch" > 0 and "browser_session"."sequence" >= 0)
);
--> statement-breakpoint
ALTER TABLE "browser_session" ADD CONSTRAINT "browser_session_thread_owner_fk" FOREIGN KEY ("thread_id","bud_id","created_by_user_id") REFERENCES "public"."thread"("thread_id","bud_id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_session_active_thread_idx" ON "browser_session" USING btree ("thread_id") WHERE "browser_session"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "browser_session_owner_idx" ON "browser_session" USING btree ("created_by_user_id","bud_id");--> statement-breakpoint
CREATE INDEX "browser_session_cleanup_idx" ON "browser_session" USING btree ("bud_id","desired_state","closed_at");