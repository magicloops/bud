# Phase 3: Validation And Docs

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/terminal-session-lifecycle-and-thread-uniqueness.md](../../design/terminal-session-lifecycle-and-thread-uniqueness.md)
**Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Objective

Verify the fixed lifecycle behaves the way users and other plans expect, then align the project docs/specs.

---

## Validation Focus

### Runtime Behavior

- create/open thread terminal
- close session explicitly
- revisit thread and get a fresh session
- reconnect Bud/service without forcing a new session
- leave a session idle and confirm it is not auto-closed by default

### API/Route Behavior

- bud sessions list still shows only non-closed sessions
- thread delete still closes the active session before soft delete
- terminal routes still return the expected `no_terminal_session` behavior only when truly appropriate

### Documentation Behavior

- no docs still claim `thread_id UNIQUE` means “one active session per thread”
- no docs still imply 24h idle auto-close is the expected default product behavior

---

## Implementation Tasks

### Task 1: Validate close/reopen end to end

Run the real thread flow:

1. open thread terminal
2. close it explicitly
3. revisit/reopen
4. confirm a fresh `session_id` is created successfully

### Task 2: Validate reconnect persistence

Run the reconnect flow:

1. create/open a terminal
2. restart or disconnect the service/Bud connection without explicit close
3. reconnect
4. confirm the same active session is resumed

### Task 3: Validate idle behavior

Confirm the configured default no longer auto-closes idle sessions unintentionally.

### Task 4: Update specs/docs

Expected docs/specs to update:

- `service/src/db/db.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/src.spec.md`
- `service/service.spec.md`
- `bud.spec.md`
- `TODO.md`

Optionally:

- `plan/mobile-auth/phase-3-api-contract-and-cleanup.md`

if the terminal-session task should link to or reflect the shipped fix.

---

## Validation Checklist

- [x] existing threads continue to work under the new active-session uniqueness model.
- [ ] explicit close then reopen works in a real local stack.
- [ ] reconnect without explicit close preserves the active session.
- [ ] idle sessions are not auto-closed under default config.
- [ ] Bud sessions listing behavior remains correct.
- [ ] thread deletion still closes the active session.
- [x] specs/docs no longer describe the old global-uniqueness model.
- [x] `TODO.md` entry for terminal-session recreation can be removed or updated.

## Status

Documentation alignment is done. Runtime validation remains open.

## Validation Note

- 2026-03-19: local testing confirmed that pre-existing threads still work after the uniqueness and idle-policy change. Remaining runtime validation is focused on explicit close/reopen, reconnect persistence, and the rest of the broader behavior matrix.

---

## Exit Criteria

This phase is complete when the lifecycle bug is fixed in practice, not just in schema shape, and the docs/specs describe the shipped behavior accurately.

---

*Last Updated: 2026-03-19*
