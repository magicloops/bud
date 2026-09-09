-- Development cutover: existing automation models were defaulted, not explicitly
-- selected. Keep their original model/effort values as historical evidence;
-- model_mode now determines whether those values are execution overrides.
-- No admitted invocation or message attribution is changed.
UPDATE automation a SET draft = a.draft || jsonb_build_object(
  'model_mode', 'inherit',
  'origin_thread_id', (SELECT p.thread_id::text FROM automation_proposal p
    JOIN thread t ON t.thread_id = p.thread_id AND t.created_by_user_id = a.created_by_user_id
      AND t.bud_id = a.draft->>'bud_id'
    WHERE p.automation_id = a.id AND p.created_by_user_id = a.created_by_user_id
    ORDER BY p.created_at, p.id LIMIT 1)),
  version = version + 1
WHERE NOT draft ? 'model_mode';
--> statement-breakpoint
UPDATE automation_revision r SET definition = r.definition || jsonb_build_object(
  'model_mode', 'inherit',
  'origin_thread_id', (SELECT p.thread_id::text FROM automation_proposal p
    JOIN thread t ON t.thread_id = p.thread_id AND t.created_by_user_id = r.created_by_user_id
      AND t.bud_id = r.definition->>'bud_id'
    WHERE p.automation_id = r.automation_id AND p.created_by_user_id = r.created_by_user_id
    ORDER BY p.created_at, p.id LIMIT 1))
WHERE NOT definition ? 'model_mode';
--> statement-breakpoint
-- A pending approval must refresh against the new policy; settled reviews remain
-- historical evidence of what was displayed at approval time.
UPDATE automation_proposal SET status = 'stale', version = version + 1, updated_at = now()
WHERE status = 'pending' AND NOT definition ? 'model_mode';
--> statement-breakpoint
UPDATE automation_bootstrap_proposal SET status = 'stale', version = version + 1, updated_at = now()
WHERE status = 'pending' AND NOT (frozen->'definition') ? 'model_mode';
