CREATE TABLE "user_file" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"created_by_user_id" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"processing_state" text DEFAULT 'pending' NOT NULL,
	"document" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "user_file_size_check" CHECK ("user_file"."size_bytes" between 1 and 26214400),
	CONSTRAINT "user_file_state_check" CHECK ("user_file"."state" in ('pending','uploading','ready','failed') and ("user_file"."state" <> 'ready' or "user_file"."sha256" ~ '^[a-f0-9]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "user_file" ADD CONSTRAINT "user_file_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_file_owner_created_idx" ON "user_file" USING btree ("created_by_user_id","created_at","id");