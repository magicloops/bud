CREATE TABLE "browser_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"bud_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"profile_generation" integer DEFAULT 1 NOT NULL,
	"control_state" text DEFAULT 'agent' NOT NULL,
	"private_content" boolean DEFAULT false NOT NULL,
	"control_epoch" integer DEFAULT 1 NOT NULL,
	"control_session_id" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"control_request_id" text,
	"desired_state" text DEFAULT 'open' NOT NULL,
	"lifecycle_request_id" text,
	"requested_by_user_id" text,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_resource_owner_key" UNIQUE("id","bud_id","created_by_user_id"),
	CONSTRAINT "browser_resource_control_check" CHECK ("browser_resource"."control_state" in ('agent','paused','human_private','resume_pending') and ("browser_resource"."control_state" <> 'agent' or not "browser_resource"."private_content") and ("browser_resource"."control_state" <> 'human_private' or ("browser_resource"."private_content" and "browser_resource"."control_session_id" is not null))),
	CONSTRAINT "browser_resource_state_check" CHECK ("browser_resource"."desired_state" in ('open','stop_pending','stopped','reset_pending') and ("browser_resource"."desired_state" not in ('stop_pending','reset_pending') or "browser_resource"."lifecycle_request_id" is not null)),
	CONSTRAINT "browser_resource_counters_check" CHECK ("browser_resource"."control_epoch" > 0 and "browser_resource"."revision" >= 0 and "browser_resource"."profile_generation" > 0),
	CONSTRAINT "browser_resource_actor_check" CHECK ("browser_resource"."requested_by_user_id" is null or "browser_resource"."requested_by_user_id" = "browser_resource"."created_by_user_id")
);
--> statement-breakpoint
ALTER TABLE "browser_session" ADD COLUMN "browser_id" text;--> statement-breakpoint
ALTER TABLE "browser_resource" ADD CONSTRAINT "browser_resource_bud_id_bud_bud_id_fk" FOREIGN KEY ("bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_resource_active_bud_idx" ON "browser_resource" USING btree ("bud_id") WHERE "browser_resource"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "browser_resource_owner_idx" ON "browser_resource" USING btree ("created_by_user_id","bud_id");--> statement-breakpoint
CREATE INDEX "browser_resource_pending_idx" ON "browser_resource" USING btree ("desired_state","updated_at");--> statement-breakpoint
ALTER TABLE "browser_session" ADD CONSTRAINT "browser_session_resource_owner_fk" FOREIGN KEY ("browser_id","bud_id","created_by_user_id") REFERENCES "public"."browser_resource"("id","bud_id","created_by_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_session_resource_idx" ON "browser_session" USING btree ("browser_id","closed_at");