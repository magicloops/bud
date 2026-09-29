-- Coordinated cutover: legacy private states have no live override. Keep the
-- execution fence until daemon acknowledgement, but never recreate human control.
UPDATE browser_resource SET control_state='paused',control_epoch=control_epoch+1,
  revision=revision+1,override_end_reason='service_restarted',updated_at=now()
WHERE retired_at IS NULL AND desired_state='open' AND control_state<>'agent';
--> statement-breakpoint
-- Lease identity changes invalidate status; 2-second deadline renewal does not.
DROP TRIGGER browser_state_resource ON browser_resource;
CREATE TRIGGER browser_state_resource AFTER INSERT OR UPDATE OR DELETE ON browser_resource
FOR EACH ROW EXECUTE FUNCTION browser_state_changed('created_by_user_id','retired_at','desired_state','control_state','private_content','control_epoch','revision','profile_generation','control_session_id','override_id');
