# Debug: drizzle-migrations-out-of-sync-with-schema

## Environment
- OS / arch / versions: macOS local dev
- DB connection style: local Postgres / migration-file analysis
- LLM mode (real/mocked): not relevant

## Repro Steps
1. Compare `service/src/db/schema.ts` to the checked-in migration chain under `service/drizzle/migrations/`.
2. Run `pnpm --dir service db:generate`.

## Observed
- The checked-in SQL migration chain only goes through `0009_slim_gauntlet.sql`.
- `db:generate` immediately produces a new catch-up migration:

```sql
ALTER TABLE "message" ADD COLUMN "client_id" uuid NOT NULL;
CREATE UNIQUE INDEX "message_client_id_idx" ON "message" USING btree ("client_id");
ALTER TABLE "terminal_session" DROP COLUMN "tmux_session_name";
```

- This confirms the migration chain is behind `schema.ts`.
- By inspection, the current checked-in migrations do **not** yet represent:
  - `message.client_id`
  - removal of `terminal_session.tmux_session_name`

## Expected
- Running `pnpm db:migrate` from a clean database should produce the same schema shape that `service/src/db/schema.ts` describes.
- The checked-in migration chain should also be safe against already-populated environments, or the repo should document an explicit staged rollout.

## Hypotheses
- The message `client_id` rollout shipped primarily via `db:push` plus backfill and never received a final checked-in migration.
- The later tmux-session-name cleanup also shipped via `db:push` and never received a checked-in migration.
- A naive generated migration is not sufficient for populated databases because `ADD COLUMN ... NOT NULL` on `message.client_id` will fail when historical rows already exist.

## Proposed Fix
- Replace the naive generated catch-up migration with a hand-authored `0010` that:
  - safely adds `message.client_id`
  - backfills existing rows in SQL
  - tightens the column to `NOT NULL`
  - adds the final unique index
  - drops `terminal_session.tmux_session_name`
- Update the migration specs/docs so they describe the new `0010` end state accurately.
- Validate the checked-in migration chain on a fresh temporary database after the migration is authored.
