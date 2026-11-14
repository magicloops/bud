CREATE TABLE "data_source_request" (
	"id" text PRIMARY KEY NOT NULL,
	"invocation_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"bud_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"call_id" text NOT NULL,
	"source" text NOT NULL,
	"purpose" text NOT NULL,
	"level" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"settled" jsonb,
	"reading_event_id" text,
	"answered_from" text,
	"answered_at" timestamp with time zone,
	"seen_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_source_request_call_key" UNIQUE("invocation_id","call_id"),
	CONSTRAINT "data_source_request_source_check" CHECK ("data_source_request"."source" in ('location', 'health', 'contacts')),
	CONSTRAINT "data_source_request_state_check" CHECK ("data_source_request"."status" in ('pending','granted','declined','unavailable','superseded','canceled') and ("data_source_request"."level" is null or "data_source_request"."level" = 'always')),
	CONSTRAINT "data_source_request_answer_check" CHECK (("data_source_request"."status" in ('granted','declined','unavailable')) = ("data_source_request"."settled" is not null and "data_source_request"."answered_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "data_source_request" ADD CONSTRAINT "data_source_request_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_request" ADD CONSTRAINT "data_source_request_invocation_fk" FOREIGN KEY ("invocation_id","thread_id","bud_id","created_by_user_id") REFERENCES "public"."agent_invocation"("id","thread_id","bud_id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_source_request" ADD CONSTRAINT "data_source_request_action_fk" FOREIGN KEY ("invocation_id","call_id") REFERENCES "public"."agent_invocation_action"("invocation_id","call_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_source_request_owner_idx" ON "data_source_request" USING btree ("created_by_user_id","source","created_at");--> statement-breakpoint
CREATE INDEX "data_source_request_thread_idx" ON "data_source_request" USING btree ("thread_id","status");--> statement-breakpoint
-- Clients waiting on a thread learn that a source request opened or was answered, like the
-- other pending requests (0050). No request content is published.
CREATE TRIGGER bud_pending_source_request AFTER INSERT OR UPDATE OR DELETE ON data_source_request
FOR EACH ROW EXECUTE FUNCTION bud_pending_requests_changed();
--> statement-breakpoint
-- The access log's page cursor carries times to the millisecond. Rows written before the
-- service set the time itself have microseconds, which a page boundary could skip or repeat.
UPDATE data_access_log SET at = date_trunc('milliseconds', at) WHERE at <> date_trunc('milliseconds', at);
