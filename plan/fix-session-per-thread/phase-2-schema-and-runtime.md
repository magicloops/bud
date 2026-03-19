# Phase 2: Schema And Runtime Alignment

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/terminal-session-lifecycle-and-thread-uniqueness.md](../../design/terminal-session-lifecycle-and-thread-uniqueness.md)

---

## Objective

Make the database and service runtime encode the chosen contract:

- uniqueness only for active session rows
- no idle auto-close by default
- explicit close still produces a closed historical row

---

## Scope

### In Scope

- `terminal_session` uniqueness migration
- Drizzle schema alignment
- runtime/config changes for idle cleanup policy
- small runtime cleanup to make the intended model obvious in code

### Out Of Scope

- terminal history aggregation across historical session rows
- Bud-side tmux changes
- UI redesign beyond behavior-compatible wording/assumptions

---

## Expected Files

- `service/src/db/schema.ts`
- `service/drizzle/migrations/*`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/config.ts`
- `service/src/db/db.spec.md`
- `service/src/runtime/runtime.spec.md`

---

## Implementation Tasks

### Task 1: Replace the current thread uniqueness rule

Current problem:

- `thread_id` is globally unique

Target rule:

- `thread_id` must be unique only where `closed_at IS NULL`

Implementation shape:

1. drop the current unique constraint on `terminal_session.thread_id`
2. add a partial unique index for active rows
3. keep a normal lookup index on `thread_id`

### Task 2: Align Drizzle schema with the real uniqueness model

The schema should stop expressing thread uniqueness as:

- `.unique()` on `threadId`

and instead reflect:

- non-unique `threadId`
- index definitions matching the active-row uniqueness model

### Task 3: Keep runtime logic compatible with the current versioned-session model

The current manager behavior is already close to correct:

- get active row by `thread_id + closed_at IS NULL`
- insert fresh row when none exists

The implementation should preserve that model and only simplify/clarify where needed.

Possible cleanup items:

- make comments/logging explicit that the lookup is for the active session
- avoid any stale code/comments implying global 1:1 row uniqueness

### Task 4: Disable idle cleanup by default

Current behavior:

- mark idle after 30 min
- close after 24h idle

Target behavior:

- idle marking may remain
- closing stale idle sessions should be disabled by default

Implementation direction:

- make cleanup conditional on config
- choose a default that disables destructive idle close

### Task 5: Preserve explicit close and thread-delete flows

Ensure no regression in:

- `closeSession(sessionId, reason)`
- `DELETE /api/buds/:budId/sessions/:sessionId`
- `DELETE /api/threads/:threadId`

Those flows should still result in a closed row and closed tmux session.

---

## Migration Notes

This migration should be low risk:

- the current global unique constraint is stricter than the new rule
- existing data therefore cannot violate the new partial unique index

The main care points are:

- checked-in migration correctness
- keeping `db:push` and `db:migrate` aligned

---

## Validation Checklist

- [x] migration drops the old thread uniqueness constraint cleanly.
- [x] migration adds the new active-row partial unique index.
- [x] `schema.ts` matches the new constraint/index model.
- [ ] creating a session for a thread with no active row succeeds.
- [ ] closing a session and reopening the thread creates a fresh row successfully.
- [x] at most one non-closed row can exist per thread.
- [x] idle sessions are not auto-closed by default.
- [ ] thread deletion still closes the active session as intended.

---

## Exit Criteria

This phase is complete when the database and runtime no longer disagree about what a thread “owns,” and the reopen bug is mechanically impossible under the new constraint model.

## Status

Implemented at the schema/runtime level. Real-stack behavioral validation is still tracked in Phase 3.

## Validation Note

- 2026-03-19: existing threads were validated against the migrated schema/runtime and continued to open successfully.

---

*Last Updated: 2026-03-19*
