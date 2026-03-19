# Phase 1: Lifecycle Policy

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/terminal-session-lifecycle-and-thread-uniqueness.md](../../design/terminal-session-lifecycle-and-thread-uniqueness.md)

---

## Objective

Freeze the lifecycle contract before changing schema or runtime code.

By the end of this phase:

- “one active session per thread” is the explicit rule
- explicit close semantics are defined
- idle behavior is settled
- reconnect persistence is distinguished from explicit close/reopen behavior

---

## Decisions To Lock

### 1. Active-session uniqueness

The contract is:

- a thread may have many historical session rows over time
- a thread may have only one non-closed session at a time

### 2. Manual close semantics

Manual close means:

- send `terminal_close` to Bud
- kill the tmux session
- mark the row closed in the database
- preserve historical output/input for that closed row
- create a fresh session next time the thread is reopened

### 3. Reconnect semantics

Reconnect means:

- same open session row
- same `session_id`
- same tmux session on the Bud

This is not the same as explicit close/reopen.

### 4. Idle policy

Chosen direction:

- idle affects status only
- idle does not auto-close by default

If cleanup remains configurable, it should be opt-in rather than the default product behavior.

---

## Implementation Tasks

### Task 1: Update the policy docs

Align the main docs/specs to state:

- one active session per thread
- historical closed rows are allowed
- explicit close creates a new session later
- idle no longer implies eventual automatic close by default

### Task 2: Decide how config should express “no auto-close”

Preferred implementation direction:

- support disabling idle cleanup through config
- default that config to disabled

Two acceptable shapes:

1. `TERMINAL_IDLE_CLEANUP_HOURS=0` means disabled
2. a dedicated boolean such as `TERMINAL_IDLE_CLEANUP_ENABLED=false`

The implementation should choose the simpler option that keeps the config surface understandable.

### Task 3: Confirm thread deletion remains explicit teardown

Thread deletion should continue to:

- close the active terminal session if one exists
- then soft-delete the thread

That behavior should remain unchanged by the uniqueness fix.

---

## Validation Checklist

- [x] lifecycle docs no longer describe global one-row-per-thread semantics.
- [x] explicit close vs reconnect behavior is clearly documented.
- [x] idle policy is explicitly documented as non-destructive by default.
- [x] thread deletion semantics remain explicit and documented.

---

## Exit Criteria

This phase is complete when the implementation work in Phase 2 has a clear contract to encode, with no remaining ambiguity about:

1. what “close” means
2. what “reconnect” means
3. whether idle sessions should disappear automatically

## Status

Completed.

---

*Last Updated: 2026-03-18*
