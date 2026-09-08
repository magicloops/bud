CREATE TABLE "automation_bootstrap_member" (
	"bootstrap_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"contact_revision_id" text NOT NULL,
	"group_index" integer NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "automation_bootstrap_member_bootstrap_id_ordinal_pk" PRIMARY KEY("bootstrap_id","ordinal"),
	CONSTRAINT "automation_bootstrap_member_revision_key" UNIQUE("bootstrap_id","contact_revision_id"),
	CONSTRAINT "automation_bootstrap_member_bounds_check" CHECK ("automation_bootstrap_member"."ordinal" between 0 and 999 and "automation_bootstrap_member"."group_index" between 0 and 999)
);
--> statement-breakpoint
CREATE TABLE "automation_bootstrap" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"revision" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"request" jsonb NOT NULL,
	"publication_boundary" bigint NOT NULL,
	"member_count" integer NOT NULL,
	"group_size" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"latest_start_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_bootstrap_owner_key" UNIQUE("id","created_by_user_id"),
	CONSTRAINT "automation_bootstrap_retry_key" UNIQUE("created_by_user_id","idempotency_key"),
	CONSTRAINT "automation_bootstrap_bounds_check" CHECK ("automation_bootstrap"."member_count" between 0 and 1000 and "automation_bootstrap"."group_size" between 1 and 25 and "automation_bootstrap"."publication_boundary" >= 0),
	CONSTRAINT "automation_bootstrap_state_check" CHECK ("automation_bootstrap"."status" in ('pending','completed','canceled','failed'))
);
--> statement-breakpoint
ALTER TABLE "automation_bootstrap_member" ADD CONSTRAINT "automation_bootstrap_member_owner_fk" FOREIGN KEY ("bootstrap_id","created_by_user_id") REFERENCES "public"."automation_bootstrap"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bootstrap_member" ADD CONSTRAINT "automation_bootstrap_member_revision_fk" FOREIGN KEY ("contact_revision_id","created_by_user_id") REFERENCES "public"."contact_revision"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bootstrap" ADD CONSTRAINT "automation_bootstrap_revision_fk" FOREIGN KEY ("automation_id","revision","created_by_user_id") REFERENCES "public"."automation_revision"("automation_id","revision","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_bootstrap_member_group_idx" ON "automation_bootstrap_member" USING btree ("bootstrap_id","group_index","ordinal");--> statement-breakpoint
CREATE INDEX "automation_bootstrap_owner_idx" ON "automation_bootstrap" USING btree ("created_by_user_id","automation_id","id");