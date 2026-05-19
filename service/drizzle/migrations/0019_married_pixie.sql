CREATE TABLE "agent_question_request" (
	"question_request_id" text PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"turn_id" text NOT NULL,
	"call_id" text NOT NULL,
	"client_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_response" jsonb,
	"tool_result" jsonb,
	"client_response_id" uuid,
	"answered_by_user_id" text,
	"answered_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"tenant_id" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_question_request" ADD CONSTRAINT "agent_question_request_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_question_request" ADD CONSTRAINT "agent_question_request_answered_by_user_id_user_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_question_request_thread_call_idx" ON "agent_question_request" USING btree ("thread_id","call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_question_request_client_response_idx" ON "agent_question_request" USING btree ("client_response_id");--> statement-breakpoint
CREATE INDEX "agent_question_request_thread_status_idx" ON "agent_question_request" USING btree ("thread_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_question_request_owner_status_idx" ON "agent_question_request" USING btree ("created_by_user_id","status","created_at");