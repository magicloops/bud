# Phase 4: Reference Client Composer Status

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Update first-party client behavior so Bud offline mode is visible without treating successful offline sends as failed messages.

By the end of this phase:

- reference web reads `/agent/state.environment`
- the composer shows Bud offline status for the active thread
- message-send reconciliation handles `agent.mode: "bud_offline"`
- mobile has a clear handoff for equivalent behavior

## Client Rules

Clients should distinguish:

- request success: user message accepted
- agent runtime: assistant is or is not responding
- environment: Bud tools are or are not currently available

For `POST /messages` success with `agent.mode: "bud_offline"`:

- keep the canonical user message
- show normal assistant loading
- do not mark the send as failed
- do not wait for a special offline failure event
- render the eventual assistant response normally

For `/agent/state.environment.mode === "bud_offline"`:

- show a small composer-level offline indicator
- do not inject a transcript row
- do not block sending
- clarify that Bud-specific actions are unavailable

## Reference Web Tasks

### Task 1: Extend client types

Add types for:

- create-message `agent` metadata
- `/agent/state.environment`
- tool availability map

### Task 2: Render composer status

Add a compact composer-level status when the current Bud is offline.

Constraints:

- keep it secondary to the message input
- do not rely only on thread-list or title status
- avoid a modal or disruptive banner for normal offline mode
- avoid implying the assistant cannot respond

Suggested copy:

```text
Bud offline. The assistant can respond, but terminal and web preview tools are unavailable.
```

### Task 3: Reconcile send response

Update the send path so:

- `201` with `agent.started: true` keeps the optimistic/canonical user message
- `agent.mode: "bud_offline"` does not show failed-send UI
- request failures still behave as failures
- duplicate `client_id` retries still converge on the canonical message

### Task 4: Runtime updates

Update state/stream reducers so:

- `/agent/state.environment` updates composer status on thread open
- active state changes update composer status while a turn runs
- optional `agent.environment` SSE is handled if the backend ships it
- clients still converge if the optional event is absent

## Mobile Handoff Notes

Mobile should mirror the same rules:

- use `/agent/state.environment` as the authoritative thread availability state
- render the offline alert in the composer
- keep send success separate from Bud availability
- keep assistant loading when an offline-aware turn starts
- stop relying on Bud status embedded in thread titles/lists as the only active-thread signal

## Tests

Add or update tests for:

- composer shows offline state from `/agent/state`
- composer hides or updates when environment returns normal
- offline-mode send success does not mark optimistic row failed
- normal request failure still marks send failed
- optional `agent.environment` event updates status without requiring a refetch

## Exit Criteria

Phase 4 is complete when web and mobile can both present Bud offline mode as degraded tool availability, not as a failed chat send.
