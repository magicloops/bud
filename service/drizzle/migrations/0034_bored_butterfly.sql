CREATE TABLE "automation_bootstrap_proposal_member" (
	"proposal_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"contact_revision_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	CONSTRAINT "automation_bootstrap_proposal_member_proposal_id_ordinal_pk" PRIMARY KEY("proposal_id","ordinal"),
	CONSTRAINT "bootstrap_proposal_member_revision_key" UNIQUE("proposal_id","contact_revision_id"),
	CONSTRAINT "bootstrap_proposal_member_ordinal_check" CHECK ("automation_bootstrap_proposal_member"."ordinal" between 0 and 999)
);
--> statement-breakpoint
CREATE TABLE "automation_bootstrap_proposal" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"revision" integer NOT NULL,
	"invocation_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"bud_id" text NOT NULL,
	"call_id" text NOT NULL,
	"frozen" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"member_count" integer NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"bootstrap_id" text,
	"decision_request" jsonb,
	"decision_idempotency_key" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bootstrap_proposal_owner_key" UNIQUE("id","created_by_user_id"),
	CONSTRAINT "bootstrap_proposal_call_key" UNIQUE("invocation_id","call_id"),
	CONSTRAINT "bootstrap_proposal_decision_key" UNIQUE("created_by_user_id","decision_idempotency_key"),
	CONSTRAINT "bootstrap_proposal_state_check" CHECK ("automation_bootstrap_proposal"."status" in ('pending','approved','declined','canceled','expired','stale') and "automation_bootstrap_proposal"."version" >= 0 and "automation_bootstrap_proposal"."revision" > 0),
	CONSTRAINT "bootstrap_proposal_member_check" CHECK ("automation_bootstrap_proposal"."member_count" between 1 and 1000 and "automation_bootstrap_proposal"."fingerprint" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "bootstrap_proposal_receipt_check" CHECK (("automation_bootstrap_proposal"."status" = 'approved') = ("automation_bootstrap_proposal"."bootstrap_id" is not null)),
	CONSTRAINT "bootstrap_proposal_decision_check" CHECK (("automation_bootstrap_proposal"."decision_request" is null and "automation_bootstrap_proposal"."decision_idempotency_key" is null and "automation_bootstrap_proposal"."decided_by_user_id" is null and "automation_bootstrap_proposal"."decided_at" is null and "automation_bootstrap_proposal"."status" not in ('approved','declined')) or ("automation_bootstrap_proposal"."decision_request" is not null and "automation_bootstrap_proposal"."decision_idempotency_key" is not null and "automation_bootstrap_proposal"."decided_by_user_id" is not null and "automation_bootstrap_proposal"."decided_at" is not null and "automation_bootstrap_proposal"."status" in ('approved','declined','canceled'))),
	CONSTRAINT "bootstrap_proposal_actor_check" CHECK ("automation_bootstrap_proposal"."decided_by_user_id" is null or "automation_bootstrap_proposal"."decided_by_user_id" = "automation_bootstrap_proposal"."created_by_user_id"),
	CONSTRAINT "bootstrap_proposal_expiry_check" CHECK ("automation_bootstrap_proposal"."expires_at" > "automation_bootstrap_proposal"."created_at")
);
--> statement-breakpoint
ALTER TABLE "automation_bootstrap_proposal_member" ADD CONSTRAINT "bootstrap_proposal_member_proposal_fk" FOREIGN KEY ("proposal_id","created_by_user_id") REFERENCES "public"."automation_bootstrap_proposal"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bootstrap_proposal_member" ADD CONSTRAINT "bootstrap_proposal_member_contact_fk" FOREIGN KEY ("contact_revision_id","created_by_user_id") REFERENCES "public"."contact_revision"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bootstrap_proposal" ADD CONSTRAINT "automation_bootstrap_proposal_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bootstrap_proposal" ADD CONSTRAINT "automation_bootstrap_proposal_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bootstrap_proposal" ADD CONSTRAINT "bootstrap_proposal_revision_fk" FOREIGN KEY ("automation_id","revision","created_by_user_id") REFERENCES "public"."automation_revision"("automation_id","revision","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bootstrap_proposal" ADD CONSTRAINT "bootstrap_proposal_invocation_fk" FOREIGN KEY ("invocation_id","thread_id","bud_id","created_by_user_id") REFERENCES "public"."agent_invocation"("id","thread_id","bud_id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bootstrap_proposal" ADD CONSTRAINT "bootstrap_proposal_action_fk" FOREIGN KEY ("invocation_id","call_id") REFERENCES "public"."agent_invocation_action"("invocation_id","call_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bootstrap_proposal" ADD CONSTRAINT "bootstrap_proposal_receipt_fk" FOREIGN KEY ("bootstrap_id","created_by_user_id") REFERENCES "public"."automation_bootstrap"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bootstrap_proposal_owner_idx" ON "automation_bootstrap_proposal" USING btree ("created_by_user_id","status","id");--> statement-breakpoint
CREATE INDEX "bootstrap_proposal_expiry_idx" ON "automation_bootstrap_proposal" USING btree ("status","expires_at");