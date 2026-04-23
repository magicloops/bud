# Debug: Staging Push Notification Migration Missing

## Environment

- Staging deploy using checked-in Drizzle migrations through `pnpm db:migrate`
- Branch: `push-notifications`
- Reported error: `relation "push_notification_outbox" does not exist`

## Repro Steps

1. Deploy push-notification backend code to staging.
2. Trigger final assistant message persistence.
3. Backend attempts to insert into `push_notification_outbox`.

## Observed

- Runtime error indicates `push_notification_outbox` is missing in staging.
- `service/src/db/schema.ts` defines push-related schema objects.
- `rg` finds `push_notification_outbox`, `push_endpoint`, `thread_read_state`, and `last_attention_*` only in `schema.ts` / specs, not in checked-in SQL migrations.
- `service/drizzle/migrations` currently stops at `0011_shallow_stellaris.sql`.

## Expected

- `pnpm db:migrate` should create:
  - `thread.last_attention_message_id`
  - `thread.last_attention_message_created_at`
  - `thread.last_attention_kind`
  - `thread_read_state`
  - `push_endpoint`
  - `push_notification_outbox`

## Hypothesis

- Local development used `pnpm db:push`, but the staging migration chain was not generated after the push-notification schema changes.

## Proposed Fix

- Generate a new checked-in Drizzle migration from the current `schema.ts`.
- Verify the generated SQL includes all push-notification tables, indexes, foreign keys, and thread attention columns.
- Update migration specs to reference the new migration.
- Run service build/tests after generation.

## Resolution

- Generated `service/drizzle/migrations/0012_plain_vulcan.sql` with `pnpm db:generate`.
- Confirmed the generated migration covers:
  - `push_endpoint`
  - `push_notification_outbox`
  - `thread_read_state`
  - `thread.last_attention_message_id`
  - `thread.last_attention_message_created_at`
  - `thread.last_attention_kind`
- Adjusted the SQL to be replay-safe for environments that already received these objects through `db:push`.
