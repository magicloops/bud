# Fix Drizzle Push Mismatch Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet started or not yet verified
- `[x]` implemented and verified
- `[-]` deferred or intentionally out of scope

## Phase 1: Schema Normalization

### Primary Key

- [ ] `threadWebViewTable.threadId` uses column-level `.primaryKey()`
- [ ] table-level one-column `thread_web_view_pkey` declaration is removed
- [ ] `thread_web_view.thread_id` still references `thread.thread_id`
- [ ] `ON DELETE cascade` is preserved for the thread FK

### Foreign Keys

- [ ] `terminal_session_input_log_session_fk` added
- [ ] `terminal_session_output_session_fk` added
- [ ] `bud_operation_terminal_session_fk` added
- [ ] `bud_operation_device_session_fk` added
- [ ] `bud_operation_transport_session_fk` added
- [ ] `bud_stream_device_session_fk` added
- [ ] `bud_stream_transport_session_fk` added
- [ ] `transport_session_device_session_fk` added
- [ ] `proxied_site_viewer_grant_site_fk` added
- [ ] `proxied_site_viewer_session_site_fk` added
- [ ] old inline long-name-generating `.references(...)` calls removed for the affected FKs
- [ ] existing referential actions are preserved

### Guardrail Test

- [ ] latest snapshot identifier-length check added
- [ ] one-column composite primary-key check added
- [ ] focused guardrail test passes

## Phase 2: Migration And Convergence

### Migration

- [ ] `pnpm --dir /Users/adam/bud/service db:generate` run
- [ ] generated SQL reviewed
- [ ] generated snapshot reviewed
- [ ] FK cleanup uses data-preserving renames or an explicitly justified alternative
- [ ] metadata-only PK SQL removed or justified
- [ ] migration file checked in
- [ ] migration metadata checked in

### Local Validation

- [ ] first `pnpm --dir /Users/adam/bud/service db:push` run after schema cleanup
- [ ] first push contains only expected cleanup or no changes
- [ ] second `pnpm --dir /Users/adam/bud/service db:push` run
- [ ] second push has no repeated FK/PK rewrite warning
- [ ] optional disposable DB migration-chain validation run or deferred

## Phase 3: Guardrails, Docs, And Handoff

### Docs

- [ ] `service/src/db/db.spec.md` updated
- [ ] `service/drizzle/migrations/migrations.spec.md` updated
- [ ] `debug/db-push-thread-web-view-primary-key.md` updated with resolution
- [ ] implementation plan checklists updated

### Handoff

- [ ] deployment note calls out migration-only staging path
- [ ] PR summary lists the migration file
- [ ] optional `db-push` preflight implemented or deferred

## Overall Progress

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Not Started | Schema still needs PK/FK normalization |
| 2 | Not Started | Migration and two-pass `db:push` convergence not verified |
| 3 | Not Started | Docs and handoff not updated |

## Notes

- Keep this checklist current as soon as implementation or verification status changes.
- If Drizzle still emits a `thread_web_view_pkey` data-loss warning after Phase 1, stop and update the debug doc before attempting another fix.
