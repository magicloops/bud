ALTER TABLE "automation_delivery" ALTER COLUMN "domain_event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_delivery" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_delivery" ADD CONSTRAINT "automation_delivery_schedule_key" UNIQUE("automation_id","scheduled_for");--> statement-breakpoint
ALTER TABLE "automation_delivery" ADD CONSTRAINT "automation_delivery_trigger_check" CHECK (("automation_delivery"."domain_event_id" is null) <> ("automation_delivery"."scheduled_for" is null));