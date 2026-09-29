ALTER TABLE "browser_handoff" ADD COLUMN "override_id" text;--> statement-breakpoint
ALTER TABLE "browser_handoff" ADD COLUMN "resolution_reason" text;--> statement-breakpoint
ALTER TABLE "browser_resource" ADD COLUMN "override_id" text;--> statement-breakpoint
ALTER TABLE "browser_resource" ADD COLUMN "override_viewer_id" text;--> statement-breakpoint
ALTER TABLE "browser_resource" ADD COLUMN "override_carrier_id" text;--> statement-breakpoint
ALTER TABLE "browser_resource" ADD COLUMN "override_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "browser_resource" ADD COLUMN "ended_override_id" text;--> statement-breakpoint
ALTER TABLE "browser_resource" ADD COLUMN "override_end_reason" text;--> statement-breakpoint
CREATE INDEX "browser_resource_override_expiry_idx" ON "browser_resource" USING btree ("override_expires_at") WHERE "browser_resource"."override_id" is not null;--> statement-breakpoint
ALTER TABLE "browser_resource" ADD CONSTRAINT "browser_resource_override_check" CHECK (("browser_resource"."override_id" is null and "browser_resource"."override_viewer_id" is null and "browser_resource"."override_carrier_id" is null and "browser_resource"."override_expires_at" is null) or ("browser_resource"."override_id" is not null and "browser_resource"."override_viewer_id" is not null and "browser_resource"."override_carrier_id" is not null and "browser_resource"."override_expires_at" is not null and "browser_resource"."control_session_id" is not null));