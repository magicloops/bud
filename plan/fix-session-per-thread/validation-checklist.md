# Session-Per-Thread Fix Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Lifecycle Policy

- [x] docs clearly state “one active session per thread,” not “one row forever per thread.”
- [x] explicit close semantics are documented.
- [x] reconnect semantics are documented separately from explicit close.
- [x] idle auto-close policy is documented as disabled-by-default or otherwise explicitly justified.

## Phase 2: Schema And Runtime

### Migration / Schema

- [x] the old global unique constraint on `terminal_session.thread_id` is removed.
- [x] a partial unique index exists for `thread_id WHERE closed_at IS NULL`.
- [x] `schema.ts` matches the migrated constraint/index model.
- [x] checked-in migrations apply successfully.

### Runtime

- [ ] opening a terminal for a thread with no active session succeeds.
- [ ] closing a session marks that row closed.
- [ ] reopening the same thread creates a fresh session row successfully.
- [ ] the service still prevents two simultaneous non-closed sessions for one thread.
- [ ] idle sessions are not auto-closed under default config.
- [ ] thread deletion still closes the active session.

## Phase 3: Real Flow Validation

### Reopen Flow

- [x] existing threads continue to work after the active-session uniqueness migration.
- [ ] open thread terminal
- [ ] close session explicitly
- [ ] revisit thread
- [ ] confirm terminal reopens with a new `session_id`

### Reconnect Flow

- [ ] open thread terminal
- [ ] disconnect/restart service or Bud without explicit close
- [ ] reconnect
- [ ] confirm the same active session resumes

### UI / API Expectations

- [ ] Bud sessions list shows only non-closed sessions.
- [ ] terminal routes only return `no_terminal_session` when there is truly no active session.
- [ ] frontend assumptions about “close then revisit creates a new session” still hold.

## Docs / Spec Alignment

- [x] `service/src/db/db.spec.md` updated
- [x] `service/src/runtime/runtime.spec.md` updated
- [x] `service/src/routes/routes.spec.md` updated
- [x] `service/src/src.spec.md` updated if needed
- [ ] `service/service.spec.md` updated if needed
- [x] `bud.spec.md` updated
- [x] `TODO.md` updated

## Notes

- 2026-03-19: local validation confirmed that pre-existing threads still work after the schema/runtime change.
- If the implementation ends up choosing a different lifecycle model than this plan, update this checklist and the design doc together before merging code.
