CREATE TABLE "thread_creation_receipt" (
	"id" text PRIMARY KEY NOT NULL,
	"creation_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"thread_id" uuid,
	"message_id" uuid,
	"invocation_id" text,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_creation_receipt_owner_key" UNIQUE("created_by_user_id","creation_key"),
	CONSTRAINT "thread_creation_receipt_fingerprint_check" CHECK ("thread_creation_receipt"."fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "thread_creation_receipt_key_check" CHECK (length("thread_creation_receipt"."creation_key") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "thread_creation_receipt" ADD CONSTRAINT "thread_creation_receipt_thread_id_thread_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("thread_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_creation_receipt" ADD CONSTRAINT "thread_creation_receipt_message_id_message_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("message_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_creation_receipt" ADD CONSTRAINT "thread_creation_receipt_invocation_id_agent_invocation_id_fk" FOREIGN KEY ("invocation_id") REFERENCES "public"."agent_invocation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_creation_receipt" ADD CONSTRAINT "thread_creation_receipt_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;