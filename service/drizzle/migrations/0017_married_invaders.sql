CREATE TABLE "llm_call_item" (
	"llm_call_item_id" text PRIMARY KEY NOT NULL,
	"llm_call_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"role" text,
	"kind" text NOT NULL,
	"sequence" integer NOT NULL,
	"provider_output_index" integer,
	"provider_content_index" integer,
	"provider_item_id" text,
	"tool_call_id" text,
	"text" text,
	"canonical_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" text DEFAULT 'provider_only' NOT NULL,
	"message_id" uuid,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_call" (
	"llm_call_id" text PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"request_mode" text NOT NULL,
	"provider_response_id" text,
	"status" text DEFAULT 'completed' NOT NULL,
	"input_fingerprint" text,
	"tool_config_fingerprint" text,
	"prompt_cache_key" text,
	"usage" jsonb,
	"cache_metadata" jsonb,
	"error" jsonb,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "llm_call_item" ADD CONSTRAINT "llm_call_item_llm_call_id_llm_call_llm_call_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_call"("llm_call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call_item" ADD CONSTRAINT "llm_call_item_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call_item" ADD CONSTRAINT "llm_call_item_message_id_message_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("message_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_call" ADD CONSTRAINT "llm_call_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_call_item_call_sequence_idx" ON "llm_call_item" USING btree ("llm_call_id","direction","sequence");--> statement-breakpoint
CREATE INDEX "llm_call_item_thread_created_idx" ON "llm_call_item" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_call_item_tool_call_idx" ON "llm_call_item" USING btree ("tool_call_id");--> statement-breakpoint
CREATE INDEX "llm_call_item_message_idx" ON "llm_call_item" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "llm_call_thread_step_idx" ON "llm_call" USING btree ("thread_id","turn_id","step_index");--> statement-breakpoint
CREATE INDEX "llm_call_provider_idx" ON "llm_call" USING btree ("provider","created_at");--> statement-breakpoint
CREATE INDEX "llm_call_status_idx" ON "llm_call" USING btree ("status","created_at");