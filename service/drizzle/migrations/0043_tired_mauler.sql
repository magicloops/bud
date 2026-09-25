ALTER TABLE "thread" ADD COLUMN "last_conversation_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE thread t SET last_conversation_at = GREATEST(t.created_at, COALESCE(
  (SELECT max(m.created_at) FROM message m WHERE m.thread_id=t.thread_id
    AND (m.role='user' OR (m.role='assistant' AND m.metadata->>'segment_kind'='final'))), t.created_at));
--> statement-breakpoint
-- Insert-trigger maintenance covers durable admission, legacy sends, and final
-- transcript writes atomically. Replays/conflicts and rollbacks cannot promote.
CREATE FUNCTION thread_conversation_message_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role='user' OR (NEW.role='assistant' AND NEW.metadata->>'segment_kind'='final') THEN
    UPDATE thread SET last_conversation_at=GREATEST(last_conversation_at,NEW.created_at)
      WHERE thread_id=NEW.thread_id AND last_conversation_at < NEW.created_at;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER thread_conversation_message AFTER INSERT ON message
FOR EACH ROW EXECUTE FUNCTION thread_conversation_message_inserted();
--> statement-breakpoint
CREATE FUNCTION thread_list_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope_row jsonb;
BEGIN
  IF TG_OP='UPDATE' AND ROW(OLD.last_conversation_at,OLD.title,OLD.deleted_at,OLD.bud_id,OLD.created_by_user_id)
      IS NOT DISTINCT FROM ROW(NEW.last_conversation_at,NEW.title,NEW.deleted_at,NEW.bud_id,NEW.created_by_user_id) THEN
    RETURN NULL;
  END IF;
  FOR scope_row IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(
    CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END)) LOOP
    IF scope_row->>'bud_id' IS NOT NULL THEN
      PERFORM pg_notify('bud_thread_list',jsonb_build_object('schema',TG_TABLE_SCHEMA,
        'bud_id',scope_row->>'bud_id')::text);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER thread_list_change AFTER INSERT OR UPDATE OR DELETE ON thread
FOR EACH ROW EXECUTE FUNCTION thread_list_changed();
