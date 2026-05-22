# Fix Drizzle Push Mismatch Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet started or not yet verified
- `[x]` implemented and verified
- `[-]` deferred or intentionally out of scope

## Phase 1: Schema Normalization

### Primary Key

- [x] `threadWebViewTable.threadId` uses column-level `.primaryKey()`
- [x] table-level one-column `thread_web_view_pkey` declaration is removed
- [x] `thread_web_view.thread_id` still references `thread.thread_id`
- [x] `ON DELETE cascade` is preserved for the thread FK

### Foreign Keys

- [x] `terminal_session_input_log_session_fk` added
- [x] `terminal_session_output_session_fk` added
- [x] `bud_operation_terminal_session_fk` added
- [x] `bud_operation_device_session_fk` added
- [x] `bud_operation_transport_session_fk` added
- [x] `bud_stream_device_session_fk` added
- [x] `bud_stream_transport_session_fk` added
- [x] `transport_session_device_session_fk` added
- [x] `proxied_site_viewer_grant_site_fk` added
- [x] `proxied_site_viewer_session_site_fk` added
- [x] old inline long-name-generating `.references(...)` calls removed for the affected FKs
- [x] existing referential actions are preserved

### Guardrail Test

- [x] latest snapshot identifier-length check added
- [x] one-column composite primary-key check added
- [x] focused guardrail test passes

## Phase 2: Migration And Convergence

### Migration

- [x] `pnpm --dir /Users/adam/bud/service db:generate` run
- [x] generated SQL reviewed
- [x] generated snapshot reviewed
- [x] FK cleanup uses data-preserving renames or an explicitly justified alternative
- [x] metadata-only PK SQL removed or justified
- [x] migration file checked in
- [x] migration metadata checked in

### Local Validation

- [x] first `pnpm --dir /Users/adam/bud/service db:push` run after schema cleanup
- [x] first push contains only expected cleanup or no changes
- [x] second `pnpm --dir /Users/adam/bud/service db:push` run
- [x] second push has no repeated FK/PK rewrite warning
- [-] optional disposable DB migration-chain validation run or deferred

## Phase 3: Guardrails, Docs, And Handoff

### Docs

- [x] `service/src/db/db.spec.md` updated
- [x] `service/drizzle/migrations/migrations.spec.md` updated
- [x] `debug/db-push-thread-web-view-primary-key.md` updated with resolution
- [x] implementation plan checklists updated

### Handoff

- [x] deployment note calls out migration-only staging path
- [-] PR summary lists the migration file
- [-] optional `db-push` preflight implemented or deferred

## Overall Progress

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Complete | Schema uses stable FK names and column-level `thread_web_view.thread_id` PK metadata |
| 2 | Complete | Migration generated/reviewed; two-pass `db:push` converges locally |
| 3 | Complete | Specs, debug note, and checklists updated; optional preflight deferred |

## Notes

- Keep this checklist current as soon as implementation or verification status changes.
- If Drizzle still emits a `thread_web_view_pkey` data-loss warning after Phase 1, stop and update the debug doc before attempting another fix.
