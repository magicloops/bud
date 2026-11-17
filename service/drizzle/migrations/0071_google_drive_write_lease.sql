CREATE TABLE "google_drive_write_lease" (
	"file_key" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "google_drive_write_lease_expiry_idx" ON "google_drive_write_lease" USING btree ("expires_at");