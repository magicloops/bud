CREATE TABLE "device_install_claim" (
	"install_claim_id" text PRIMARY KEY NOT NULL,
	"claim_token_hash" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"tenant_id" text,
	"device_name_hint" text,
	"install_scope" text DEFAULT 'machine' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"redeemed_bud_id" text,
	"redeemed_installation_id" text,
	"redeemed_user_agent" text,
	"redeemed_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_install_claim" ADD CONSTRAINT "device_install_claim_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_install_claim" ADD CONSTRAINT "device_install_claim_redeemed_bud_id_bud_bud_id_fk" FOREIGN KEY ("redeemed_bud_id") REFERENCES "public"."bud"("bud_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_install_claim_token_hash_idx" ON "device_install_claim" USING btree ("claim_token_hash");--> statement-breakpoint
CREATE INDEX "device_install_claim_owner_expires_idx" ON "device_install_claim" USING btree ("created_by_user_id","expires_at");--> statement-breakpoint
CREATE INDEX "device_install_claim_redeemed_bud_idx" ON "device_install_claim" USING btree ("redeemed_bud_id");