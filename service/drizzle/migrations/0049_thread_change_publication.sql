-- Notifications are post-commit hints only. No transcript content or credentials.
CREATE FUNCTION bud_thread_change_hint(schema_name text, owner_id text, thread_id uuid, kind text, message_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF owner_id IS NOT NULL THEN
    PERFORM pg_notify('bud_thread_changes', jsonb_build_object('schema',schema_name,
      'owner',owner_id,'thread_id',thread_id,'kind',kind,'message_id',message_id)::text);
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION bud_thread_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-'updated_at') IS NOT DISTINCT FROM (to_jsonb(NEW)-'updated_at') THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' THEN
    PERFORM bud_thread_change_hint(TG_TABLE_SCHEMA,OLD.created_by_user_id,OLD.thread_id,'reset');
  ELSIF TG_OP='UPDATE' THEN
    IF (to_jsonb(OLD)->'created_by_user_id',to_jsonb(OLD)->'bud_id',to_jsonb(OLD)->'deleted_at') IS DISTINCT FROM
       (to_jsonb(NEW)->'created_by_user_id',to_jsonb(NEW)->'bud_id',to_jsonb(NEW)->'deleted_at') THEN
      PERFORM bud_thread_change_hint(TG_TABLE_SCHEMA,OLD.created_by_user_id,OLD.thread_id,'reset');
      PERFORM bud_thread_change_hint(TG_TABLE_SCHEMA,NEW.created_by_user_id,NEW.thread_id,'reset');
    END IF;
  END IF;
  FOR r IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(
    CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END)) LOOP
    PERFORM bud_thread_change_hint(TG_TABLE_SCHEMA,r->>'created_by_user_id',(r->>'thread_id')::uuid,'summary');
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER bud_thread_changed AFTER INSERT OR UPDATE OR DELETE ON thread
FOR EACH ROW EXECUTE FUNCTION bud_thread_changed();
--> statement-breakpoint
CREATE FUNCTION bud_thread_joined_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; owner_id text;
BEGIN
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='terminal_session' THEN
    IF ROW(OLD.thread_id,OLD.created_by_user_id,OLD.state,OLD.closed_at) IS NOT DISTINCT FROM
    ROW(NEW.thread_id,NEW.created_by_user_id,NEW.state,NEW.closed_at) THEN RETURN NULL; END IF;
  END IF;
  FOR r IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(
    CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END)) LOOP
    SELECT created_by_user_id INTO owner_id FROM thread WHERE thread_id=(r->>'thread_id')::uuid;
    PERFORM bud_thread_change_hint(TG_TABLE_SCHEMA,owner_id,(r->>'thread_id')::uuid,'summary');
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER bud_thread_read_changed AFTER INSERT OR UPDATE OR DELETE ON thread_read_state
FOR EACH ROW EXECUTE FUNCTION bud_thread_joined_changed();
--> statement-breakpoint
CREATE TRIGGER bud_thread_terminal_changed AFTER INSERT OR UPDATE OR DELETE ON terminal_session
FOR EACH ROW EXECUTE FUNCTION bud_thread_joined_changed();
--> statement-breakpoint
CREATE FUNCTION bud_thread_owner_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.created_by_user_id IS NOT DISTINCT FROM NEW.created_by_user_id THEN RETURN NULL; END IF;
  IF TG_OP<>'INSERT' THEN PERFORM bud_thread_change_hint(TG_TABLE_SCHEMA,OLD.created_by_user_id,NULL,'reset'); END IF;
  IF TG_OP<>'DELETE' THEN PERFORM bud_thread_change_hint(TG_TABLE_SCHEMA,NEW.created_by_user_id,NULL,'reset'); END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER bud_thread_owner_changed AFTER UPDATE OR DELETE ON bud
FOR EACH ROW EXECUTE FUNCTION bud_thread_owner_changed();
--> statement-breakpoint
CREATE FUNCTION bud_transcript_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(OLD)-'updated_at') IS NOT DISTINCT FROM (to_jsonb(NEW)-'updated_at') THEN RETURN NULL; END IF;
  FOR r IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(
    CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END)) LOOP
    IF r->>'thread_id' IS NOT NULL THEN
      PERFORM bud_thread_change_hint(TG_TABLE_SCHEMA,r->>'created_by_user_id',(r->>'thread_id')::uuid,
        CASE WHEN TG_OP='INSERT' THEN 'message' ELSE 'transcript' END,(r->>'message_id')::uuid);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER bud_transcript_changed AFTER INSERT OR UPDATE OR DELETE ON message
FOR EACH ROW EXECUTE FUNCTION bud_transcript_changed();

--> statement-breakpoint
-- Replaced by the owner-scoped full-summary feed in the coordinated client upgrade.
DROP TRIGGER IF EXISTS thread_list_change ON thread;
--> statement-breakpoint
DROP FUNCTION IF EXISTS thread_list_changed();
