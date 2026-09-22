-- Custom migration: Drizzle cannot express triggers, so this SQL is maintained by
-- hand. `db:push` will neither create nor drop it; keep this file and the
-- `browser_resource` schema in step.
--
-- Ownership/claim changes must quarantine the old browser profile even if no
-- browser request arrives between unclaim and re-claim. The Bud row is locked
-- first by the UPDATE that fires the trigger.
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
