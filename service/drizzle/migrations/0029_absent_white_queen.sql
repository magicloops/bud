CREATE TABLE "automation_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"revision" integer NOT NULL,
	"domain_event_id" text NOT NULL,
	"invocation_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome_code" text,
	"latest_start_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_delivery_event_key" UNIQUE("automation_id","revision","domain_event_id"),
	CONSTRAINT "automation_delivery_invocation_key" UNIQUE("invocation_id"),
	CONSTRAINT "automation_delivery_state_check" CHECK ("automation_delivery"."status" in ('pending','admitted','suppressed','expired','canceled','failed')),
	CONSTRAINT "automation_delivery_admission_check" CHECK (("automation_delivery"."status" = 'admitted') = ("automation_delivery"."invocation_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "automation_revision" (
	"automation_id" text NOT NULL,
	"revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"publication_boundary" bigint NOT NULL,
	"grant_version" integer NOT NULL,
	"activated_by_user_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_revision_automation_id_revision_pk" PRIMARY KEY("automation_id","revision"),
	CONSTRAINT "automation_revision_owner_key" UNIQUE("automation_id","revision","created_by_user_id"),
	CONSTRAINT "automation_revision_number_check" CHECK ("automation_revision"."revision" > 0 and "automation_revision"."publication_boundary" >= 0 and "automation_revision"."grant_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "automation" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"draft" jsonb NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"active_revision" integer,
	"created_by_user_id" text NOT NULL,
	"updated_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_owner_key" UNIQUE("id","created_by_user_id"),
	CONSTRAINT "automation_state_check" CHECK ("automation"."state" in ('draft','enabled','paused')),
	CONSTRAINT "automation_version_check" CHECK ("automation"."version" >= 0 and ("automation"."active_revision" is null or "automation"."active_revision" > 0))
);
--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD COLUMN "publication_sequence" bigint;--> statement-breakpoint
ALTER TABLE "data_owner_state" ADD COLUMN "publication_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD CONSTRAINT "data_domain_owner_key" UNIQUE("id","created_by_user_id");--> statement-breakpoint
ALTER TABLE "automation_delivery" ADD CONSTRAINT "automation_delivery_revision_fk" FOREIGN KEY ("automation_id","revision","created_by_user_id") REFERENCES "public"."automation_revision"("automation_id","revision","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_delivery" ADD CONSTRAINT "automation_delivery_event_fk" FOREIGN KEY ("domain_event_id","created_by_user_id") REFERENCES "public"."data_domain_event"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_delivery" ADD CONSTRAINT "automation_delivery_invocation_fk" FOREIGN KEY ("invocation_id","created_by_user_id") REFERENCES "public"."agent_invocation"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_revision" ADD CONSTRAINT "automation_revision_activated_by_user_id_user_id_fk" FOREIGN KEY ("activated_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_revision" ADD CONSTRAINT "automation_revision_owner_fk" FOREIGN KEY ("automation_id","created_by_user_id") REFERENCES "public"."automation"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_delivery_owner_idx" ON "automation_delivery" USING btree ("created_by_user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "automation_delivery_due_idx" ON "automation_delivery" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "automation_owner_idx" ON "automation" USING btree ("created_by_user_id","created_at","id");--> statement-breakpoint
ALTER TABLE "data_domain_event" ADD CONSTRAINT "data_domain_sequence_key" UNIQUE("created_by_user_id","publication_sequence");