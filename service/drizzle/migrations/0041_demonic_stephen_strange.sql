CREATE TABLE "browser_viewer_visit" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" uuid NOT NULL,
	"bud_id" text NOT NULL,
	"viewer_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"grant_hash" text NOT NULL,
	"token_hash" text,
	"grant_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_viewer_visit" ADD CONSTRAINT "browser_viewer_visit_session_fk" FOREIGN KEY ("session_id","thread_id","bud_id","created_by_user_id") REFERENCES "public"."browser_session"("id","thread_id","bud_id","created_by_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_viewer_visit_grant_idx" ON "browser_viewer_visit" USING btree ("grant_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_viewer_visit_token_idx" ON "browser_viewer_visit" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "browser_viewer_visit_owner_idx" ON "browser_viewer_visit" USING btree ("created_by_user_id","expires_at");