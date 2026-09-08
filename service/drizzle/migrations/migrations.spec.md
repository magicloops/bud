# migrations

SQL migration files generated or maintained for schema evolution.

## Purpose

Contains the checked-in SQL migration chain used to align staging with the schema-first local workflow. Managed by Drizzle metadata under `meta/` and applied via `pnpm db:migrate`.

## Files

### `0037_huge_wendigo.sql`

Adds owner/thread-bound web retrieval request receipts and expiring artifacts,
unique call/request identities, status/size checks and budget/owner/expiry
indexes. Additive migration generated from schema; executed in an isolated test
schema and applied locally transactionally after reviewing and aborting
db:push's unrelated constraint recreation. Deploy before enabling retrieval.

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

### `0023_superb_alex_wilder.sql`

**Terminal proto 0.3 cutover (stem terminal command lifecycle)**:
- Creates `terminal_command`: daemon-minted `command_id` ULID PK, `terminal_session_id` FK (cascade), `thread_id`, `bud_id`, owner stamps (`created_by_user_id`, nullable `tenant_id`), `command_started_at`, nullable `command_finished_at` / `exit_code`, and bigint `output_byte_start` / `output_byte_end` for slicing transcript output from `terminal_session_output`
- Adds session/started, thread/started, and bud indexes
- Drops the retired `terminal_session_output.seq` column and `terminal_session_output_seq_idx` (proto 0.3 makes `byte_offset` the sole ordering/dedup/resume coordinate; dropping `seq` is destructive by design for this pre-release cutover)

### `0024_true_luminals.sql`

Personal-data ingestion foundation: creates `data_owner_state`, `data_installation`, `data_collection_epoch`, `data_event` and `data_processing_job`. Adds required owner stamps, composite owner foreign keys with table-level uniqueness, immutable event dedupe and occurrence/receipt/due-work indexes. Generated from schema and reviewed; equivalent schema applied locally via `db:push`. Staging migration verification has not run.

### `0025_careful_trauma.sql`

Contacts projection foundation: creates `contact_source`, `contact_scan`, `contact_scan_record`, `contact`, `contact_revision` and `data_domain_event`, with source/generation/event uniqueness, composite owner foreign keys and lookup indexes. Equivalent schema applied locally via `db:push`; migration generated and reviewed.

### `0026_supreme_human_cannonball.sql`

Creates normalized `location_observation` and owner-wide versioned `agent_data_grant`, with owner/raw-event/epoch foreign keys, unique raw-event association and owner/occurrence lookup index. Generated and reviewed; equivalent schema applied locally via `db:push`. No daemon protocol change or deployment.

### Reasoning Message Role Audit

No migration follows `0022` for adding `reasoning` to the TypeScript
`messageRoleValues` tuple. The Phase 5 reasoning-message audit confirmed
`message.role` is physically PostgreSQL `text` in both the latest Drizzle
snapshot and the local database, no `message_role` enum or role check
constraint exists, and `pnpm db:generate` reports no schema changes.

## Migration Naming

### `0035_flippant_killmonger.sql`

Adds `agent_data_grant.contact_fields` JSONB, required with the legacy four-field
default. Existing grants gain no expanded access. Generated/reviewed SQL applied
locally in a transaction after canceling `db:push`'s unrelated invocation
constraint prompt. No table rebuild, grant-version change or deployment.

Earlier files follow Drizzle Kit's `{sequence}_{adjective}_{noun}.sql` pattern. Later files may use explicit semantic names when they are authored to preserve a deliberate rollout.

## Subfolder

### `meta/`

Drizzle Kit metadata tracking migration state. Contains:
- `_journal.json` - Migration history
- Snapshot files for each migration (`0000` through `0037` currently)

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
 │
 ▼
v23: terminal proto 0.3 command lifecycle (+ drop terminal_session_output.seq)
```

---

*Referenced by: [../drizzle.spec.md](../drizzle.spec.md)*

### `0027_aspiring_triton.sql`

Creates durable invocation/action tables, stable turn/input/idempotency constraints, owner FKs, lease/state checks and a partial unique active-thread reservation. Adds referenced owner-composite uniqueness on existing message/thread tables without changing their rows. Generated SQL was reviewed and its two referenced unique-constraint statements moved ahead of the dependent FKs. Metadata remains generated. Applied locally via `db:push`; SQL also executes in an isolated-schema test. Runtime adoption and staging deployment remain pending.

### `0028_blue_risque.sql`

Adds `agent_invocation.reserves_thread`, backfills active/review/question reservations and replaces the unique active-thread index with a reservation predicate. Generated SQL was augmented with the backfill before index creation. Column applied by local `db:push`; reviewed backfill/index replacement applied transactionally because push omitted the predicate change. Both invocation migrations execute in isolated-schema validation. Not deployed.

### `0029_absent_white_queen.sql`

Creates automation draft/revision/delivery tables with owner-composite foreign
keys, dedupe, state checks and due/history indexes. Adds owner publication counters
and nullable sequence on historical domain events. Moved the generated domain
owner uniqueness ahead of its dependent delivery FK. Reviewed SQL applied locally
in one transaction after reviewing db:push, whose proposed ordering had the same
FK issue. Metadata remains generated. PostgreSQL publication/delivery constraint
tests pass; deployment and activation/matching integration remain pending.

### `0030_stormy_prima.sql`

Creates owner-bound bootstrap requests and frozen contact-revision membership, including retry uniqueness, count/group/state checks, ordered lookup indexes and composite owner foreign keys. Generated SQL and metadata reviewed; referenced uniqueness precedes dependent foreign keys. Applied the reviewed SQL locally in one transaction after reviewing `pnpm db:push`, excluding unrelated invocation constraint recreation from the push proposal. PostgreSQL snapshot/retry/cutover tests and metadata checks pass. No deployment.

### `0031_next_veda.sql`

Creates durable bootstrap groups with request/group primary key, unique invocation association, owner FKs, admission/state/bounds checks and due/owner indexes. Reviewed generated SQL augmented with membership-derived backfill for preexisting requests, retaining canceled/failed request state. Applied locally in one transaction after reviewing db:push and excluding unrelated constraint recreation. No deployment.

### `0032_flat_wilson_fisk.sql`

Creates immutable app permission requests and one query-key/grant record per
request, with owner/context/action/site FKs, decision/call/key dedupe, actor and
handoff state checks, owner inventory and expiry indexes. Stores verification
hashes and encrypted delivery only. Adds invocation-context/site-owner unique
constraints; these generated statements were moved before dependent FKs without
editing generated metadata. Reviewed SQL applied locally transactionally after
reviewing db:push and excluding unrelated constraint recreation. No deployment.

### `0033_natural_avengers.sql`

Creates automation proposals with frozen definition/draft/grant versions,
owner-bound rule and invocation context, unique originating action call and
decision retry key, expiry, typed status checks and approved-revision association.
Complete human decisions must identify the owner; automatic terminal outcomes
carry no fabricated actor. Generated SQL executed in a rolled-back isolated
schema with ownership/dedupe/state tests. Applied locally in one transaction after
canceling the unrelated invocation constraint prompt in `db:push`. No deployment;
repository transitions and API/runtime adoption remain pending.

### `0034_bored_butterfly.sql`

Creates separate existing-contact proposal and ordered membership tables. Adds
owner/context/action/revision/contact/receipt foreign keys, call/decision/member
uniqueness, owner/expiry indexes and bounded membership/fingerprint/state/actor
checks. Existing activation proposal rows are untouched, preventing older
activation-only code from interpreting new reviews. Generated SQL executes in an
isolated rolled-back schema fixture. Applied locally transactionally after
canceling db:push's unrelated invocation-constraint prompt. Not deployed; typed
decision repository and runtime integration remain pending.

### `0036_magical_ken_ellis.sql`

Expands the automation state constraint to include terminal `deleted`; no rows,
columns or history are removed. Generated metadata remains unedited. Reviewed SQL
applied locally transactionally after canceling db:push's unrelated invocation
constraint recreation prompt. Isolated-schema execution and metadata tests pass.
