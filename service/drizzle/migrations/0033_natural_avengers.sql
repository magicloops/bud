CREATE TABLE "automation_proposal" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"invocation_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"bud_id" text NOT NULL,
	"call_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"draft_version" integer NOT NULL,
	"grant_version" integer NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"activated_revision" integer,
	"decision_request" jsonb,
	"decision_idempotency_key" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_proposal_owner_key" UNIQUE("id","created_by_user_id"),
	CONSTRAINT "automation_proposal_call_key" UNIQUE("invocation_id","call_id"),
	CONSTRAINT "automation_proposal_decision_key" UNIQUE("created_by_user_id","decision_idempotency_key"),
	CONSTRAINT "automation_proposal_state_check" CHECK ("automation_proposal"."status" in ('pending','approved','declined','canceled','expired','stale')),
	CONSTRAINT "automation_proposal_version_check" CHECK ("automation_proposal"."version" >= 0 and "automation_proposal"."draft_version" >= 0 and "automation_proposal"."grant_version" >= 0),
	CONSTRAINT "automation_proposal_revision_check" CHECK (("automation_proposal"."status" = 'approved') = ("automation_proposal"."activated_revision" is not null) and ("automation_proposal"."activated_revision" is null or "automation_proposal"."activated_revision" > 0)),
	CONSTRAINT "automation_proposal_decision_check" CHECK (("automation_proposal"."decision_request" is null and "automation_proposal"."decision_idempotency_key" is null and "automation_proposal"."decided_by_user_id" is null and "automation_proposal"."decided_at" is null and "automation_proposal"."status" not in ('approved','declined')) or ("automation_proposal"."decision_request" is not null and "automation_proposal"."decision_idempotency_key" is not null and "automation_proposal"."decided_by_user_id" is not null and "automation_proposal"."decided_at" is not null and "automation_proposal"."status" in ('approved','declined','canceled'))),
	CONSTRAINT "automation_proposal_actor_check" CHECK ("automation_proposal"."decided_by_user_id" is null or "automation_proposal"."decided_by_user_id" = "automation_proposal"."created_by_user_id"),
	CONSTRAINT "automation_proposal_expiry_check" CHECK ("automation_proposal"."expires_at" > "automation_proposal"."created_at")
);
--> statement-breakpoint
ALTER TABLE "automation_proposal" ADD CONSTRAINT "automation_proposal_decided_by_user_id_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_proposal" ADD CONSTRAINT "automation_proposal_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_proposal" ADD CONSTRAINT "automation_proposal_automation_fk" FOREIGN KEY ("automation_id","created_by_user_id") REFERENCES "public"."automation"("id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_proposal" ADD CONSTRAINT "automation_proposal_invocation_fk" FOREIGN KEY ("invocation_id","thread_id","bud_id","created_by_user_id") REFERENCES "public"."agent_invocation"("id","thread_id","bud_id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_proposal" ADD CONSTRAINT "automation_proposal_action_fk" FOREIGN KEY ("invocation_id","call_id") REFERENCES "public"."agent_invocation_action"("invocation_id","call_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_proposal" ADD CONSTRAINT "automation_proposal_revision_fk" FOREIGN KEY ("automation_id","activated_revision","created_by_user_id") REFERENCES "public"."automation_revision"("automation_id","revision","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_proposal_owner_idx" ON "automation_proposal" USING btree ("created_by_user_id","status","id");--> statement-breakpoint
CREATE INDEX "automation_proposal_expiry_idx" ON "automation_proposal" USING btree ("status","expires_at");