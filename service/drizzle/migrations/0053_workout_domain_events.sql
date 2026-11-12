ALTER TABLE "health_workout" ADD CONSTRAINT "health_workout_owner_key" UNIQUE("id","created_by_user_id");--> statement-breakpoint
ALTER TABLE "data_domain_event" ALTER COLUMN "revision_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD COLUMN "workout_id" text;--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD CONSTRAINT "data_domain_workout_fk" FOREIGN KEY ("workout_id","created_by_user_id") REFERENCES "public"."health_workout"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD CONSTRAINT "data_domain_workout_key" UNIQUE("workout_id","event_type");--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD CONSTRAINT "data_domain_subject_check" CHECK (("data_domain_event"."revision_id" is null) <> ("data_domain_event"."workout_id" is null));