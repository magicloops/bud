-- Catch up the checked-in migration chain for push-notification storage.
-- Local development may already have this schema from `pnpm db:push`, so keep
-- the SQL replay-safe for partially synced environments.
CREATE TABLE IF NOT EXISTS "push_endpoint" (
	"endpoint_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"platform" text NOT NULL,
	"provider" text NOT NULL,
	"provider_environment" text,
	"app_id" text NOT NULL,
	"token" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"alerts_agent_completed" boolean DEFAULT true NOT NULL,
	"alerts_human_input_requested" boolean DEFAULT true NOT NULL,
	"include_message_preview" boolean DEFAULT true NOT NULL,
	"invalidated_at" timestamp with time zone,
	"last_registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_notification_outbox" (
	"notification_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"message_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"dedupe_key" text NOT NULL,
	"collapse_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"suppressed_reason" text,
	"last_error_code" text,
	"last_error_message" text,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "thread_read_state" (
	"thread_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"last_seen_message_id" uuid,
	"last_seen_message_created_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_read_state_pkey" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN IF NOT EXISTS "last_attention_message_id" uuid;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN IF NOT EXISTS "last_attention_message_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "thread" ADD COLUMN IF NOT EXISTS "last_attention_kind" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "push_endpoint" ADD CONSTRAINT "push_endpoint_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "push_notification_outbox" ADD CONSTRAINT "push_notification_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "push_notification_outbox" ADD CONSTRAINT "push_notification_outbox_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "push_notification_outbox" ADD CONSTRAINT "push_notification_outbox_message_id_message_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("message_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "thread_read_state" ADD CONSTRAINT "thread_read_state_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "thread_read_state" ADD CONSTRAINT "thread_read_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_endpoint_user_installation_idx" ON "push_endpoint" USING btree ("user_id","installation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_endpoint_user_idx" ON "push_endpoint" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_endpoint_provider_token_idx" ON "push_endpoint" USING btree ("provider","token");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_notification_outbox_dedupe_idx" ON "push_notification_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_notification_outbox_status_idx" ON "push_notification_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_notification_outbox_user_idx" ON "push_notification_outbox" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_notification_outbox_thread_idx" ON "push_notification_outbox" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "thread_read_state_user_idx" ON "thread_read_state" USING btree ("user_id","last_seen_at");
