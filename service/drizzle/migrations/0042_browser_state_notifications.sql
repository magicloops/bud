-- Hints only: PostgreSQL delivers NOTIFY after commit, never after rollback.
-- Filter out heartbeat/sequence/timestamp updates so idle work stays idle.
CREATE OR REPLACE FUNCTION browser_state_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  before_row jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  after_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  field text;
  changed boolean := TG_OP <> 'UPDATE';
  row_data jsonb;
BEGIN
  FOREACH field IN ARRAY TG_ARGV LOOP
    IF before_row->field IS DISTINCT FROM after_row->field THEN changed := true; END IF;
  END LOOP;
  IF changed THEN
    -- Notify old and new scopes on ownership/reparenting; viewers reauthorize.
    FOR row_data IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(before_row,after_row)) LOOP
      IF row_data->>'bud_id' IS NOT NULL THEN
        PERFORM pg_notify('bud_browser_state', jsonb_build_object(
          'schema',TG_TABLE_SCHEMA,'bud_id',row_data->>'bud_id',
          'thread_id',CASE WHEN TG_TABLE_NAME IN ('thread','browser_session','browser_handoff')
            THEN row_data->>'thread_id' ELSE NULL END)::text);
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER browser_state_resource AFTER INSERT OR UPDATE OR DELETE ON browser_resource
FOR EACH ROW EXECUTE FUNCTION browser_state_changed('created_by_user_id','retired_at','desired_state','control_state','private_content','control_epoch','revision','profile_generation','control_session_id');
--> statement-breakpoint
CREATE TRIGGER browser_state_session AFTER INSERT OR UPDATE OR DELETE ON browser_session
FOR EACH ROW EXECUTE FUNCTION browser_state_changed('created_by_user_id','thread_id','bud_id','browser_id','generation','boot_id','state','desired_state','closed_at');
--> statement-breakpoint
CREATE TRIGGER browser_state_handoff AFTER INSERT OR UPDATE OR DELETE ON browser_handoff
FOR EACH ROW EXECUTE FUNCTION browser_state_changed('created_by_user_id','thread_id','bud_id','status');
--> statement-breakpoint
CREATE TRIGGER browser_state_bud AFTER UPDATE OR DELETE ON bud
FOR EACH ROW EXECUTE FUNCTION browser_state_changed('created_by_user_id','status','capabilities','device_secret');
--> statement-breakpoint
CREATE TRIGGER browser_state_thread AFTER UPDATE OR DELETE ON thread
FOR EACH ROW EXECUTE FUNCTION browser_state_changed('created_by_user_id','bud_id','deleted_at');
