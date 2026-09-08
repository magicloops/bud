CREATE TABLE "web_retrieval_artifact" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"bud_id" text NOT NULL,
	"request_id" text NOT NULL,
	"operation" text NOT NULL,
	"backend" text NOT NULL,
	"payload" jsonb NOT NULL,
	"byte_length" integer NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "web_retrieval_artifact_request_key" UNIQUE("request_id"),
	CONSTRAINT "web_retrieval_artifact_size_check" CHECK ("web_retrieval_artifact"."byte_length" between 0 and 524288)
);
--> statement-breakpoint
CREATE TABLE "web_retrieval_request" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"bud_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"call_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"backend" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_retrieval_request_call_key" UNIQUE("thread_id","turn_id","call_id"),
	CONSTRAINT "web_retrieval_request_state_check" CHECK ("web_retrieval_request"."status" in ('started','completed','failed'))
);
--> statement-breakpoint
ALTER TABLE "web_retrieval_artifact" ADD CONSTRAINT "web_retrieval_artifact_request_id_web_retrieval_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."web_retrieval_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_retrieval_artifact" ADD CONSTRAINT "web_retrieval_artifact_thread_fk" FOREIGN KEY ("thread_id","bud_id","created_by_user_id") REFERENCES "public"."thread"("thread_id","bud_id","created_by_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_retrieval_request" ADD CONSTRAINT "web_retrieval_request_thread_fk" FOREIGN KEY ("thread_id","bud_id","created_by_user_id") REFERENCES "public"."thread"("thread_id","bud_id","created_by_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_retrieval_artifact_owner_idx" ON "web_retrieval_artifact" USING btree ("created_by_user_id","thread_id");--> statement-breakpoint
CREATE INDEX "web_retrieval_artifact_expiry_idx" ON "web_retrieval_artifact" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "web_retrieval_request_budget_idx" ON "web_retrieval_request" USING btree ("created_by_user_id","thread_id","turn_id");