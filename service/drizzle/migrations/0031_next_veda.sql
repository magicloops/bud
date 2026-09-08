CREATE TABLE "automation_bootstrap_group" (
	"bootstrap_id" text NOT NULL,
	"group_index" integer NOT NULL,
	"invocation_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome_code" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_bootstrap_group_bootstrap_id_group_index_pk" PRIMARY KEY("bootstrap_id","group_index"),
	CONSTRAINT "automation_bootstrap_group_invocation_key" UNIQUE("invocation_id"),
	CONSTRAINT "automation_bootstrap_group_bounds_check" CHECK ("automation_bootstrap_group"."group_index" between 0 and 999),
	CONSTRAINT "automation_bootstrap_group_state_check" CHECK ("automation_bootstrap_group"."status" in ('pending','admitted','expired','canceled','failed')),
	CONSTRAINT "automation_bootstrap_group_admission_check" CHECK (("automation_bootstrap_group"."status" = 'admitted') = ("automation_bootstrap_group"."invocation_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "automation_bootstrap_group" ADD CONSTRAINT "automation_bootstrap_group_owner_fk" FOREIGN KEY ("bootstrap_id","created_by_user_id") REFERENCES "public"."automation_bootstrap"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bootstrap_group" ADD CONSTRAINT "automation_bootstrap_group_invocation_fk" FOREIGN KEY ("invocation_id","created_by_user_id") REFERENCES "public"."agent_invocation"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_bootstrap_group_due_idx" ON "automation_bootstrap_group" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "automation_bootstrap_group_owner_idx" ON "automation_bootstrap_group" USING btree ("created_by_user_id","bootstrap_id","group_index");
--> statement-breakpoint
INSERT INTO "automation_bootstrap_group" ("bootstrap_id", "group_index", "status", "created_by_user_id", "tenant_id")
SELECT DISTINCT b.id, m.group_index,
  CASE WHEN b.status IN ('canceled', 'failed') THEN b.status ELSE 'pending' END,
  b.created_by_user_id, b.tenant_id
FROM automation_bootstrap b
JOIN automation_bootstrap_member m ON m.bootstrap_id = b.id AND m.created_by_user_id = b.created_by_user_id;
