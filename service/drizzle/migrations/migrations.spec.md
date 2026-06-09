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

### `0011_shallow_stellaris.sql`

**Final legacy standalone-run schema cleanup**:
- Drops `run`, `run_step`, `run_log`, and `run_summary`
- Drops `terminal_session_input_log.run_id`
- Aligns staging/deployed schemas with the service refactor’s removed standalone run/runtime surface

### `0012_plain_vulcan.sql`

**Push notification schema catch-up**:
- Adds thread attention summary columns used by unread/badge semantics
- Creates `thread_read_state` for per-user read watermarks
- Creates `push_endpoint` for owned mobile push endpoint registrations
- Creates `push_notification_outbox` for durable push delivery, suppression, retry, and dead-letter state
- Uses replay-safe `IF NOT EXISTS` / guarded constraint creation so environments that already received the schema via `db:push` can still apply the checked-in migration chain

### `0013_strange_nocturne.sql`

**Network upgrade durability foundation**:
- Creates `device_session` for daemon control-session epochs, heartbeat timestamps, gateway ownership, and drain state
- Creates `transport_session` for WebSocket/HTTP2/QUIC transport records and health metadata
- Creates `bud_operation` for durable daemon-directed operation lifecycle, idempotency, typed errors, ownership stamps, and terminal/thread references
- Creates `bud_stream` for stream lifecycle, type, traffic class, offsets, credits, reset reason, and typed stream errors
- Creates `audit_event` as the append-only audit foundation for daemon/session/operation/stream events
- Adds indexes for Bud/state lookups, thread operation history, transport stream recovery, device heartbeat scanning, and audit queries

### `0014_worthless_frank_castle.sql`

**Phase 4.1 proxy session foundation**:
- Creates `proxy_session` for user-owned localhost proxy sessions
- Stores Bud/thread/operation/active-stream references, localhost target host/port, allowed methods, session state, TTL, revocation fields, display metadata, and audit correlation id
- Adds owner/state, Bud/state, thread, and audit-correlation indexes
- Adds foreign keys to `bud`, `thread`, `bud_operation`, `bud_stream`, and `auth.user`

### `0015_gifted_kinsey_walden.sql`

**Phase 4.3 file session foundation**:
- Creates `file_session` for user-owned file stat/read/range sessions
- Stores Bud/thread/operation/active-stream references, root key, root-relative path, allowed permissions, max bytes, session state, optional content identity, TTL, revocation fields, display metadata, and audit correlation id
- Adds owner/state, Bud/state, thread, and audit-correlation indexes
- Adds foreign keys to `bud`, `thread`, `bud_operation`, `bud_stream`, and `auth.user`

### `0016_keen_wendigo.sql`

**Thread model-preference persistence**:
- Adds nullable `thread.model_id`
- Adds nullable `thread.reasoning_effort`
- Leaves historical threads valid while new writes persist the resolved concrete model/reasoning selection

### `0017_married_invaders.sql`

**LLM provider ledger**:
- Creates `llm_call` for one row per provider invocation, including thread/turn/step, provider/model/request mode, provider response id, status, usage, cache metadata, and ownership stamps
- Creates `llm_call_item` for ordered provider input/output items with canonical and provider payload JSON, visibility classification, tool-call ids, and optional product-message links
- Adds foreign keys to `thread`, `message`, and `llm_call`
- Adds provider diagnostics, call-sequence, thread-created, tool-call, and message-link indexes

### `0018_luxuriant_bloodstorm.sql`

**Durable product web proxy**:
- Creates `proxied_site` for long-lived owner-private web proxy endpoints with generated slugs, endpoint hosts, loopback target host/port/path, enabled/expiry/renewal state, audit correlation, and owner stamps
- Creates `thread_web_view` for the current thread-to-proxied-site attachment
- Creates `proxied_site_viewer_grant` for short-lived one-time bootstrap tokens
- Creates `proxied_site_viewer_session` for hashed endpoint-host viewer cookies with Better Auth session refresh binding
- Adds owner, endpoint-host, attachment, grant, and viewer-session indexes plus foreign keys to `bud`, `thread`, `bud_operation`, `bud_stream`, and `auth.user`

### `0019_married_pixie.sql`

**Agent question request persistence**:
- Creates `agent_question_request` for durable `ask_user_questions` request/response state
- Stores thread/turn/call identity, client-visible tool `client_id`, normalized request JSON, accepted client response JSON, generated tool-result JSON, status, answerer, optional expiry, and owner stamps
- Adds unique `(thread_id, call_id)` and nullable `client_response_id` idempotency indexes
- Adds thread/status and owner/status indexes plus foreign keys to `thread` and `auth.user`

### `0020_aromatic_zemo.sql`

**Drizzle push convergence cleanup**:
- Renames overlong FK constraints that PostgreSQL had truncated at the 63-byte identifier limit to stable explicit names
- Aligns `thread_web_view.thread_id` Drizzle metadata with PostgreSQL one-column primary-key introspection
- Preserves the physical `thread_web_view_pkey` definition as `PRIMARY KEY(thread_id)`
- Avoids data-changing table rewrites; local validation confirmed an immediate second `pnpm db:push` reports no changes

### `0021_worried_luminals.sql`

**Automatic context compaction checkpoint foundation**:
- Creates `agent_context_checkpoint` for durable service-owned model-context compaction checkpoints
- Stores trigger/reason/phase/status, summarizer provider/model/reasoning metadata, raw summary text, provider-neutral replacement history JSON, compacted-through message and LLM-call boundaries, token counts, bounded failure diagnostics, and owner stamps
- Adds thread/status/created, message-boundary, and LLM-boundary indexes
- Adds a cascading foreign key to `thread`

### `0022_bored_rocket_racer.sql`

**Device install claim foundation**:
- Creates `device_install_claim` for 10 minute authenticated one-command Bud install claims
- Stores a unique hash-at-rest bearer token, owner stamp, optional device name hint, install scope, expiry, redemption timestamp, redeemed Bud/install ids, user agent, and IP audit metadata
- Adds owner/expiry, token-hash, and redeemed-Bud indexes
- Adds foreign keys to `auth.user` and `bud`

### Reasoning Message Role Audit

No migration follows `0022` for adding `reasoning` to the TypeScript
`messageRoleValues` tuple. The Phase 5 reasoning-message audit confirmed
`message.role` is physically PostgreSQL `text` in both the latest Drizzle
snapshot and the local database, no `message_role` enum or role check
constraint exists, and `pnpm db:generate` reports no schema changes.

## Migration Naming

Earlier files follow Drizzle Kit's `{sequence}_{adjective}_{noun}.sql` pattern. Later files may use explicit semantic names when they are authored to preserve a deliberate rollout.

## Subfolder

### `meta/`

Drizzle Kit metadata tracking migration state. Contains:
- `_journal.json` - Migration history
- Snapshot files for each migration (`0000` through `0022` currently)

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
 │
 ▼
v11: drop dead standalone-run schema remnants
 │
 ▼
v12: push notification endpoint, read-state, attention, and outbox schema
 │
 ▼
v13: network upgrade device sessions, transport sessions, operations, streams, and audit events
 │
 ▼
v14: Phase 4.1 localhost proxy session persistence
 │
 ▼
v15: Phase 4.3 file session persistence
 │
 ▼
v16: thread model-preference persistence
 │
 ▼
v17: LLM provider-call and ordered-item ledger
 │
 ▼
v18: durable proxied-site, thread web-view attachment, viewer-grant, and viewer-session schema
 │
 ▼
v19: agent question request persistence for ask_user_questions
 │
 ▼
v20: Drizzle/PostgreSQL constraint metadata convergence cleanup
 │
 ▼
v21: automatic context compaction checkpoints
 │
 ▼
v22: device install claims
```

---

*Referenced by: [../drizzle.spec.md](../drizzle.spec.md)*
