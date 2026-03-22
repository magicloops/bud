# Implementation Spec: Fix Session-Per-Thread Lifecycle

**Status**: Implemented, Partially Validated
**Created**: 2026-03-18
**Design Doc**: [../../design/terminal-session-lifecycle-and-thread-uniqueness.md](../../design/terminal-session-lifecycle-and-thread-uniqueness.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)

---

## Context

Bud’s current terminal model is supposed to provide persistent thread-scoped tmux sessions.

What the code did before this implementation slice:

- a thread can have one non-closed `terminal_session` row at a time
- closing a session marks the row closed and sets `closed_at`
- reopening the thread attempts to create a fresh row
- idle cleanup auto-closed sessions after 24 hours

What the database still enforces:

- `terminal_session.thread_id` is globally unique

That mismatch is the root cause of the reopen bug:

- the runtime assumes closed rows no longer own the thread slot
- the database still reserves the thread slot forever

The Bud daemon itself already supports durable tmux reattachment by `session_id`, so this is primarily a service-side lifecycle and schema problem.

---

## Objective

Align the service/runtime/database contract so terminal sessions behave the way the product expects:

- one active session per thread at a time
- sessions persist across service and Bud reconnects
- sessions do not auto-close by default just because they became idle
- explicit close still works and frees Bud resources
- revisiting a thread after explicit close works cleanly

---

## Chosen Direction

This plan assumes the recommendation from the design doc:

1. keep versioned session rows
2. make uniqueness apply only to active rows
3. disable idle auto-close by default

Concretely:

- a thread may have multiple historical `terminal_session` rows over time
- only one row with `closed_at IS NULL` may exist per thread
- manual close ends that specific session row
- a later revisit creates a new session row with a new `session_id`
- non-closed sessions survive reconnects and remain tied to the same tmux session

---

## Success Criteria

- [x] `terminal_session` no longer blocks reopen just because a closed row already exists for the thread.
- [x] at most one non-closed session can exist per thread.
- [x] idle sessions are not auto-closed by default.
- [ ] manual session close still kills the tmux session and marks the row closed.
- [ ] revisiting the thread after manual close creates a fresh session successfully.
- [ ] reconnecting Bud/service/browser clients keeps the same non-closed session alive.
- [x] docs/specs reflect the actual lifecycle contract.

## Validation Notes

- 2026-03-19: local validation confirmed that existing threads continue to work under the new active-session uniqueness model after the schema/runtime change.
- Explicit close-then-reopen and reconnect-persistence validation remain tracked separately below.

---

## Non-Goals

- No redesign of Bud-side tmux durability.
- No aggregation of terminal history across multiple historical session rows in this tranche.
- No collaboration or multi-viewer session ownership changes.
- No redesign of the Bud sessions modal beyond whatever wording/behavior is needed to match the fixed lifecycle.

---

## Phase Overview

| Phase | Document | Primary Outcome |
|-------|----------|-----------------|
| 1 | [phase-1-lifecycle-policy.md](./phase-1-lifecycle-policy.md) | The lifecycle contract is explicit: active-session uniqueness, manual close semantics, and idle policy are settled |
| 2 | [phase-2-schema-and-runtime.md](./phase-2-schema-and-runtime.md) | Database and service runtime match the chosen contract |
| 3 | [phase-3-validation-and-docs.md](./phase-3-validation-and-docs.md) | End-to-end behavior is verified and docs/specs are aligned |

---

## Expected Files And Areas

### Service

- `service/src/db/schema.ts`
- `service/drizzle/migrations/*`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/config.ts`
- `service/src/routes/threads.ts`
- `service/src/routes/buds.ts`

### Documentation / Specs

- `design/terminal-session-lifecycle-and-thread-uniqueness.md`
- `service/src/db/db.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/src.spec.md`
- `service/service.spec.md`
- `bud.spec.md`
- `TODO.md`

### Possibly Impacted Web Docs

- `web/src/routes/routes.spec.md`
- `web/src/lib/lib.spec.md`

Only if close/reopen wording or assumptions need to be updated for the frontend contract.

---

## Sequencing Notes

- Phase 1 should land before schema work so we do not encode the wrong lifecycle in migrations.
- Phase 2 should be implemented as one coherent service/DB pass; do not land the schema change without the matching runtime/config changes.
- Phase 3 is the release gate. Do not treat the migration as “fixed” until real close/reopen and reconnect flows are verified.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Idle auto-close remains enabled somewhere and silently recreates the bug path later | Medium | High | Make idle cleanup behavior an explicit Phase 1 decision and validate it in Phase 3 |
| Schema migration is updated but service/docs still describe the old one-row-per-thread model | Medium | Medium | Update runtime/spec docs in the same tranche |
| Reopen works, but Bud sessions modal or thread-terminal history assumptions become inconsistent | Medium | Medium | Keep “new session after explicit close” as the chosen contract and validate UI wording |
| Existing local/prod migration workflows drift again | Medium | Medium | Treat this as checked-in migration work, not a `db:push`-only fix |

---

## Rollout Strategy

1. Settle the lifecycle contract and idle policy.
2. Land the schema + runtime alignment.
3. Validate close/reopen and reconnect flows against a real local stack.
4. Update the remaining specs/docs and clear the TODO item.

---

## Definition Of Done

- [x] partial uniqueness for active session rows is implemented and migrated.
- [x] idle auto-close is disabled by default or otherwise matches the documented contract.
- [ ] explicit close semantics remain intact.
- [ ] thread revisit after close works.
- [ ] reconnect persistence works for non-closed sessions.
- [x] docs/specs are updated for every touched area.

---

## Progress Tracking

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | Completed | Contract is documented in the design + plan docs and reflected in service specs |
| 2 | Completed | Schema, config, runtime, and migration changes are landed |
| 3 | In Progress | Existing-thread validation is confirmed locally; explicit close/reopen and reconnect validation still remain |

---

*Last Updated: 2026-03-19*
