# Debug: drizzle-migration-history-repair

## Environment

- macOS (arm64)
- `service/` using checked-in Drizzle SQL migrations under `service/drizzle/migrations/`
- Better Auth OAuth/JWT foundation work added on top of the existing schema

## Repro Steps

1. From `service/`, run `pnpm exec drizzle-kit generate`.
2. Observe Drizzle stop for interactive rename/create questions instead of emitting a clean migration.
3. Inspect `service/drizzle/migrations/meta/_journal.json` and compare it to the files present in `service/drizzle/migrations/meta/`.
4. Compare the missing metadata steps against the real SQL files in `service/drizzle/migrations/`.

## Observed

- `_journal.json` records a seven-step history from `0000` through `0006`.
- The `meta/` directory only contains snapshots for `0000`, `0001`, `0002`, and `0004`.
- The missing snapshots are:
  - `0003_thread_current_session`
  - `0005_terminal_output_pk_byte_offset`
  - `0006_terminal_sessions`
- `0004_snapshot.json` already includes the `0003` schema change (`thread.current_session_id` plus `thread_current_session_idx`), but its `prevId` still points to `0002`, so the snapshot chain itself skips `0003`.
- `0005_terminal_output_pk_byte_offset.sql` changes the `terminal_output` primary key from `(bud_id, seq)` to `(bud_id, byte_offset)` and swaps the supporting indexes, but there is no snapshot capturing that state.
- `0006_terminal_sessions.sql` replaces the legacy `bud_terminal` / `terminal_output` / `terminal_input_log` tables with the current `terminal_session` / `terminal_session_output` / `terminal_session_input_log` tables, but there is no snapshot for that final pre-auth baseline either.
- With the snapshot chain broken, Drizzle diffs the current schema from an outdated baseline and starts asking rename questions such as `Is auth.account table created or renamed from another table?` instead of producing a reliable migration.

## Expected

- `drizzle-kit generate` should treat the `0006` terminal-session schema as the baseline for new work.
- After metadata repair, Drizzle should produce only real diffs for current schema changes, not rename hallucinations caused by stale migration metadata.

## Hypotheses

- The immediate blocker is the incomplete and inconsistent snapshot chain in `service/drizzle/migrations/meta/`, not the checked-in SQL migration files themselves.
- Repairing the snapshot chain should unblock future `drizzle-kit generate` runs without rewriting or renumbering the existing `0000`-`0006` SQL history.
- Once the chain is repaired, Drizzle may still surface legitimate diffs if `schema.ts` has drifted beyond the `0006` migration baseline via prior `db:push` usage.

## Proposed Fix

1. Treat the existing SQL files and `_journal.json` entries for `0000`-`0006` as authoritative history.
2. Reconstruct the missing snapshot chain instead of editing the SQL migrations:
   - Create `0003_snapshot.json` from the `0002` state plus `0003_thread_current_session.sql`.
   - Update `0004_snapshot.json` so its `prevId` points to the new `0003` snapshot id.
   - Create `0005_snapshot.json` from the repaired `0004` state plus `0005_terminal_output_pk_byte_offset.sql`.
   - Create `0006_snapshot.json` from the `0005` state plus `0006_terminal_sessions.sql`.
3. Validate the reconstructed snapshots against the SQL history:
   - `0003`: `thread.current_session_id` and `thread_current_session_idx`
   - `0005`: `terminal_output` primary key and index changes
   - `0006`: `thread.deleted_at`, `thread_deleted_idx`, new `terminal_session*` tables, dropped legacy terminal tables
4. Re-run `pnpm exec drizzle-kit generate` after the metadata repair and confirm Drizzle stops prompting for bogus renames.
5. Only after the history is repaired, generate the new checked-in migration(s) for the Better Auth OAuth/JWT changes and any other current schema work.

## Unknowns

- Does the current `service/src/db/schema.ts` contain post-`0006` drift from previous `db:push` changes that still need real migrations after the history is repaired?
- Are all production and staging databases actually aligned to the `0006` SQL history, or has any environment been advanced outside the checked-in migration chain?
- Will Drizzle accept manually reconstructed snapshot files as long as the schema JSON and `id` / `prevId` chain are valid, or is there additional internal metadata we need to preserve?
- The `_journal.json` `when` timestamps for `0005` and `0006` are earlier than `0004`. This may be harmless if ordering is strictly by `idx`, but it should be verified before relying on the repaired metadata long-term.

## Fallback

- If Drizzle refuses the reconstructed snapshot chain, the fallback is to squash to a new migration baseline after confirming every environment is already at an equivalent schema state.
- That fallback is higher risk because it changes the migration contract for production, so it should only be used if snapshot-chain repair proves unworkable.

## Resolution

- Restored the missing snapshot chain for `0003`, `0005`, and `0006`, and re-linked `0004` to the repaired parent snapshot.
- Added `0007_auth_foundation.sql` plus `0008_drop_legacy_sessions.sql` with matching `meta/` snapshots and journal entries.
- Verified the on-disk `0006 -> 0007` and `0007 -> 0008` diffs match the checked-in SQL.
- Verified `pnpm db:generate` now exits cleanly with `No schema changes, nothing to migrate 😴`.
- Adjusted `0007` and `0008` to be idempotent for local databases that had already been advanced through `pnpm db:push` before the checked-in migration history existed.
- Fixed the idempotent FK guards in `0007` to use `to_regclass(...)` with quoted relation names, because Better Auth's camelCase auth tables (`oauthAccessToken`, `oauthRefreshToken`, etc.) are quoted identifiers and fail when referenced through unquoted `::regclass` casts.
