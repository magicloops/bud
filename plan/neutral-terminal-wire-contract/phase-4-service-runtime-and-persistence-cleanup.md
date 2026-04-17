# Phase 4: Service Runtime And Persistence Cleanup

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Remove service-owned tmux session naming from runtime state and persistence so the service no longer behaves as if tmux session identity is part of the product model.

## Context

Even after wire cleanup, the service still has deeper tmux coupling if it:

- derives tmux session names from `session_id`
- stores `tmuxSessionName` as first-class runtime state
- persists `tmux_session_name` in the schema without a real consumer

This phase removes that remaining dependency and closes the loop on the main non-wire leakage identified in the design doc.

## Scope

### In Scope

- runtime cleanup in `TerminalSessionManager`
- removal of `tmuxSessionName` from status/fetch paths
- schema cleanup if no real consumers remain
- DB/spec updates if the schema changes

### Out Of Scope

- inventing a generic replacement field without a real consumer
- adding a diagnostics surface

## Implementation Tasks

### Task 1: Remove tmux-name derivation from runtime logic

Delete or stop using helpers such as:

- `TerminalSessionManager.tmuxSessionName(sessionId)`

The service should rely on the stable public `session_id` and daemon-managed terminal lifecycle, not a predicted backend-local identifier.

### Task 2: Remove first-class runtime dependence on `tmuxSessionName`

Update runtime code so:

- status handling does not store `payload.info.tmux_session`
- fetch/status helpers do not emit tmux session names
- in-memory/runtime terminal state stays product-level

### Task 3: Audit for real consumers

Before removing the DB column, do a repo-wide consumer audit.

If no real consumer remains, the recommended path is to remove:

- `terminal_session.tmux_session_name`

instead of renaming it to a generic field.

### Task 4: Apply schema cleanup if the audit is clear

If the audit shows no real consumer:

- update `service/src/db/schema.ts`
- run `drizzle-kit push` when the implementation lands
- update `service/src/db/db.spec.md`

If an unexpected consumer remains:

- stop at runtime cleanup
- document the blocker explicitly
- do not invent `backend_session_id` as a speculative replacement

## Files Likely Affected

### Service Runtime

- `service/src/runtime/terminal-session-manager.ts`
- `service/src/runtime/*.test.ts`
- `service/src/terminal/types.ts`

### Service DB

- `service/src/db/schema.ts`
- `service/src/db/db.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| A hidden debugging or ops workflow still depends on the column | Medium | Medium | Do an explicit consumer audit before schema removal; separate runtime cleanup from schema deletion if needed |
| The team is tempted to preserve the field under a generic name "just in case" | Medium | Medium | Treat renamed generic persistence without a real consumer as an anti-goal in this phase |

## Exit Criteria

- the service no longer derives tmux session names from `session_id`
- runtime state no longer depends on `tmuxSessionName`
- if no real consumer remains, the schema column is removed rather than renamed

