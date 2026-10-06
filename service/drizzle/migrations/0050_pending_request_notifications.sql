-- Visibility invalidation uses the existing commit-delivered channel. PostgreSQL
-- coalesces identical hints within a transaction. No request bodies are published.
CREATE FUNCTION bud_pending_requests_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; scope_thread uuid; scope_owner text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='agent_invocation' THEN
      IF ROW(OLD.thread_id,OLD.created_by_user_id,OLD.status,OLD.reserves_thread,OLD.cancel_requested_at)
        IS NOT DISTINCT FROM ROW(NEW.thread_id,NEW.created_by_user_id,NEW.status,NEW.reserves_thread,NEW.cancel_requested_at)
        THEN RETURN NULL; END IF;
    ELSIF (to_jsonb(OLD)-'updated_at') IS NOT DISTINCT FROM (to_jsonb(NEW)-'updated_at') THEN RETURN NULL;
    END IF;
  END IF;
  -- Ordinary tool action progress is unrelated to pending human input.
  IF TG_TABLE_NAME='agent_invocation_action' AND
    COALESCE(to_jsonb(OLD)->>'status','') <> 'waiting_for_user' AND
    COALESCE(to_jsonb(NEW)->>'status','') <> 'waiting_for_user' THEN RETURN NULL; END IF;
  FOR r IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(
    CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END)) LOOP
    scope_owner := r->>'created_by_user_id';
    scope_thread := (r->>'thread_id')::uuid;
    IF TG_TABLE_NAME='agent_invocation_action' THEN
      SELECT thread_id INTO scope_thread FROM agent_invocation
        WHERE id=r->>'invocation_id' AND created_by_user_id=scope_owner;
    END IF;
    IF scope_thread IS NOT NULL THEN
      PERFORM bud_thread_change_hint(TG_TABLE_SCHEMA,scope_owner,scope_thread,'pending');
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER bud_pending_questions AFTER INSERT OR UPDATE OR DELETE ON agent_question_request
FOR EACH ROW EXECUTE FUNCTION bud_pending_requests_changed();
--> statement-breakpoint
CREATE TRIGGER bud_pending_data AFTER INSERT OR UPDATE OR DELETE ON data_access_request
FOR EACH ROW EXECUTE FUNCTION bud_pending_requests_changed();
--> statement-breakpoint
CREATE TRIGGER bud_pending_automation AFTER INSERT OR UPDATE OR DELETE ON automation_proposal
FOR EACH ROW EXECUTE FUNCTION bud_pending_requests_changed();
--> statement-breakpoint
CREATE TRIGGER bud_pending_bootstrap AFTER INSERT OR UPDATE OR DELETE ON automation_bootstrap_proposal
FOR EACH ROW EXECUTE FUNCTION bud_pending_requests_changed();
--> statement-breakpoint
CREATE TRIGGER bud_pending_browser AFTER INSERT OR UPDATE OR DELETE ON browser_handoff
FOR EACH ROW EXECUTE FUNCTION bud_pending_requests_changed();
--> statement-breakpoint
CREATE TRIGGER bud_pending_invocation AFTER INSERT OR UPDATE OR DELETE ON agent_invocation
FOR EACH ROW EXECUTE FUNCTION bud_pending_requests_changed();
--> statement-breakpoint
CREATE TRIGGER bud_pending_action AFTER INSERT OR UPDATE OR DELETE ON agent_invocation_action
FOR EACH ROW EXECUTE FUNCTION bud_pending_requests_changed();
