-- Retire the pre-release ephemeral workspaces; do not import their cookies/tabs.
UPDATE "browser_session" SET state='closed',desired_state='closed',closed_at=now(),updated_at=now()
WHERE browser_id IS NULL AND closed_at IS NULL;
--> statement-breakpoint
ALTER TABLE "browser_session" DROP CONSTRAINT "browser_session_control_check";--> statement-breakpoint
ALTER TABLE "browser_session" DROP CONSTRAINT "browser_session_state_check";--> statement-breakpoint
ALTER TABLE "browser_session" DROP COLUMN "profile_mode";--> statement-breakpoint
ALTER TABLE "browser_session" DROP COLUMN "control_state";--> statement-breakpoint
ALTER TABLE "browser_session" DROP COLUMN "private_content";--> statement-breakpoint
ALTER TABLE "browser_session" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "browser_session" DROP COLUMN "control_request_id";--> statement-breakpoint
ALTER TABLE "browser_session" ADD CONSTRAINT "browser_session_linked_check" CHECK ("browser_session"."closed_at" is not null or "browser_session"."browser_id" is not null);--> statement-breakpoint
ALTER TABLE "browser_session" ADD CONSTRAINT "browser_session_state_check" CHECK ("browser_session"."state" in ('opening','ready','interrupted','closed') and "browser_session"."desired_state" in ('open','closed'));
--> statement-breakpoint
-- Ownership/claim changes must quarantine the old profile even if no browser
-- request arrives between unclaim and re-claim. The Bud row is locked first.
CREATE FUNCTION "public".retire_bud_browser_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id
     OR OLD.device_secret IS DISTINCT FROM NEW.device_secret THEN
    UPDATE "public".browser_resource SET retired_at=now(),control_state='paused',
      control_epoch=control_epoch+1,revision=revision+1,updated_at=now()
      WHERE bud_id=NEW.bud_id AND retired_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER browser_claim_retirement BEFORE UPDATE OF created_by_user_id,device_secret
ON "bud" FOR EACH ROW EXECUTE FUNCTION "public".retire_bud_browser_claim();
