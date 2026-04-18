# migrations

SQL migration files generated or maintained for schema evolution.

## Purpose

Contains the checked-in SQL migration chain used to align staging with the schema-first local workflow. Managed by Drizzle metadata under `meta/` and applied via `pnpm db:migrate`.

## Files

### `.gitkeep`

Placeholder to ensure the directory exists in git.

### `0000_opposite_morbius.sql`

**Initial schema**:
- Creates the base `bud`, `enrollment_token`, `thread`, `message`, `run`, `run_step`, and `run_log` tables

### `0001_stiff_magdalene.sql`

**Metadata enrichment**:
- Adds `run_summary`
- Adds Bud/message/thread metadata fields such as `display_name`, message `metadata`, and thread activity counters

### `0002_glorious_james_howlett.sql`

**Legacy sessions**:
- Creates the legacy `session` and `session_log` tables
- Switches `bud.capabilities` to the object-shaped default used by later builds

### `0003_thread_current_session.sql`

**Thread-session linking**:
- Adds `thread.current_session_id`
- Adds `thread_current_session_idx`

### `0004_smart_joystick.sql`

**Bud-scoped terminal infrastructure**:
- Creates `bud_terminal`, `terminal_output`, and `terminal_input_log`
- Extends terminal/session defaults for long-lived tmux-style usage

### `0005_terminal_output_pk_byte_offset.sql`

**Terminal output primary-key fix**:
- Changes `terminal_output` primary key from `(bud_id, seq)` to `(bud_id, byte_offset)`
- Replaces the old offset index with a `(bud_id, seq)` compatibility index

### `0006_terminal_sessions.sql`

**Thread-scoped terminal sessions**:
- Adds `thread.deleted_at` and `thread_deleted_idx`
- Creates `terminal_session`, `terminal_session_output`, and `terminal_session_input_log`
- Drops legacy `bud_terminal`, `terminal_output`, and `terminal_input_log`

### `0007_auth_foundation.sql`

**Auth foundation rollout**:
- Creates the Better Auth tables under the `auth` schema
- Creates `device_auth_flow` and `user_profile`
- Adds `bud.installation_id`
- Adds `terminal_session.state_snapshot`
- Renames the terminal-session FK and unique constraint set to match the current Drizzle schema
- Uses idempotent guards so an existing local database that was already bootstrapped via `pnpm db:push` can be aligned with the checked-in migration history

### `0008_drop_legacy_sessions.sql`

**Legacy session cleanup**:
- Drops `public.session` and `public.session_log`
- Removes `thread.current_session_id` and `thread_current_session_idx`
- Uses `IF EXISTS` guards so replay on an already-clean local database is harmless

### `0009_slim_gauntlet.sql`

**Terminal-session lifecycle fix**:
- Drops the old global uniqueness constraint on `terminal_session.thread_id`
- Adds `terminal_session_thread_active_unique_idx` so only non-closed rows must be unique per thread
- Uses `IF EXISTS` guards for the prior constraint names and index replay safety

### `0010_amazing_lightspeed.sql`

**Schema catch-up for migration parity**:
- Adds `message.client_id`
- Backfills existing message rows before tightening the column to `NOT NULL`
- Adds the final `message_client_id_idx` unique index
- Drops `terminal_session.tmux_session_name` to match the neutral-terminal contract cleanup
- Uses `IF EXISTS` / `IF NOT EXISTS` guards so the migration can be applied safely on environments that previously received part of this schema via `db:push`

## Migration Naming

Earlier files follow Drizzle Kit's `{sequence}_{adjective}_{noun}.sql` pattern. Later files may use explicit semantic names when they are authored to preserve a deliberate rollout.

## Subfolder

### `meta/`

Drizzle Kit metadata tracking migration state. Contains:
- `_journal.json` - Migration history
- Snapshot files for each migration (`0000` through `0008` currently)

`meta/` is operationally important, not disposable. `drizzle-kit generate` uses the latest snapshot chain as its diff baseline; if `_journal.json` entries exist without matching `*_snapshot.json` files, future migration generation can drift into bogus rename prompts instead of clean SQL diffs.

## Usage

```bash
# Generate migration when staging history must catch up with schema.ts
pnpm db:generate

# Apply pending migrations in staging/deployed environments
pnpm db:migrate

# Push schema directly for local development
pnpm db:push
```

## Schema Evolution

```
v0: base Bud/thread/run schema
 │
 ▼
v1: run summary + metadata enrichment
 │
 ▼
v2: legacy session/session_log support
 │
 ▼
v3: thread.current_session_id link
 │
 ▼
v4-5: bud-scoped terminal storage refinements
 │
 ▼
v6: thread-scoped terminal sessions
 │
 ▼
v7: auth foundation + mobile/device auth support
 │
 ▼
v8: drop legacy session tables and thread session pointer
 │
 ▼
v9: active-session uniqueness for terminal_session.thread_id
 │
 ▼
v10: message client-id parity + terminal-session tmux-name cleanup
```

---

*Referenced by: [../drizzle.spec.md](../drizzle.spec.md)*
