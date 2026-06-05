# Phase 6.1: Runtime Agent Error Surfacing

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented
**Related Debug**: [../../debug/ds4-concurrency-ui-and-context-budget.md](../../debug/ds4-concurrency-ui-and-context-budget.md)
**Defers**: [phase-6-generic-agent-failure-messages.md](./phase-6-generic-agent-failure-messages.md)

---

## Objective

Surface asynchronous agent failures in the existing thread UI error slot without
writing failed assistant rows into the transcript.

The immediate trigger is Bud-local ds4 failure visibility. Examples:

- `DATA_PLANE_STREAM_LIMIT_EXCEEDED`: a second local model request starts while
  one `local_llm_http` stream is already active.
- `LOCAL_LLM_RESPONSE_IDLE_TIMEOUT`: the daemon accepted a local model response
  stream, then no response bytes arrived before the daemon idle timeout.

By the end of this phase:

- missed fast `final(status: "failed")` SSE events are visible after
  `/agent/state` refresh
- failures render in the current composer error area, not as transcript messages
- browser-visible error text is sanitized
- model-visible conversation reconstruction does not include runtime failure
  messages
- canceled turns stay separate from failed turns

## Rationale

Phase 6 originally scoped durable failed assistant transcript rows. That is more
robust across refreshes and service restarts, but it raises product and model
context questions:

- whether infrastructure failures should appear as chat history
- whether failed rows should count as assistant attention or push events
- whether failed rows should be replayed to the model on future turns

For the current ds4 validation path, we can solve the observed UI gap with a
smaller runtime-state feature. The existing route already owns a top-level
`error` state and passes it to `CommandComposer`, which renders the error above
the textarea.

## Current Behavior

Today the service emits a transient SSE final event on non-cancel agent failure:

```json
{
  "event": "final",
  "data": {
    "turn_id": "...",
    "status": "failed",
    "error": "raw or semi-raw error message"
  }
}
```

`useAgentStream(...)` passes that error to the route through `onError`, and the
route passes it into `CommandComposer.error`.

The gap is that fast failures can complete before the browser reattaches or
after the route refreshes to a cursor beyond the failed final event. Because no
durable transcript row exists, the error can disappear.

## Proposed Design

Add a runtime-state-only `last_error` field to `/agent/state`.

Suggested shape:

```json
{
  "last_error": {
    "turn_id": "01...",
    "code": "LOCAL_LLM_RESPONSE_IDLE_TIMEOUT",
    "message": "The local model stopped streaming for too long. Try again with a shorter request.",
    "retryable": true,
    "occurred_at": "2026-06-04T00:00:00.000Z"
  }
}
```

This is not persisted to `message`, not stored in provider-ledger replay, and
not included in model context. It is a UI/runtime status snapshot.

### Failure Formatting

Use one generic service formatter for non-cancel agent failures.

Rules:

- preserve stable error codes when present
- default code to `AGENT_FAILED`
- sanitize user-visible copy
- never expose stack traces, local URLs, request bodies, provider payloads, API
  keys, or daemon raw transport details
- treat `AbortError` / `agent_canceled` outside this path

Initial category mapping:

| Codes | User Message |
| --- | --- |
| `DATA_PLANE_STREAM_LIMIT_EXCEEDED`, `BUD_BUSY` | `The local model is already busy. Try again after the current run finishes.` |
| `LOCAL_LLM_RESPONSE_IDLE_TIMEOUT`, `LOCAL_LLM_OPEN_IDLE_TIMEOUT` | `The local model stopped streaming for too long. Try again with a shorter request.` |
| `LOCAL_LLM_CONNECT_FAILED`, `LOCAL_LLM_NOT_CONFIGURED` | `The local model is unavailable. Check that it is running on the Bud machine.` |
| fallback | `Bud could not complete this turn. Try again.` |

Optionally append a stable code for local debugging:

```text
The local model stopped streaming for too long. Try again with a shorter request.

Error: LOCAL_LLM_RESPONSE_IDLE_TIMEOUT
```

### Runtime State Policy

Add runtime manager methods similar to:

```typescript
setLastError(threadId, {
  turnId,
  code,
  message,
  retryable,
  occurredAt,
})
clearLastError(threadId)
```

Clear `last_error` when:

- a new user message is accepted for the thread
- a turn succeeds
- a turn is canceled
- the user dismisses the composer error if we add an explicit dismiss control

Keep `last_error` when:

- the route refreshes `/agent/state`
- `final(status: "failed")` was missed by the SSE client
- the agent is idle after a failure

This is in-memory runtime state. It is acceptable for the first pass that errors
do not survive service restart.

### Web UI Policy

Use the existing route/composer error path:

- `/$budId/$threadId.tsx` reads `agentState.last_error` during loader bootstrap,
  post-send refresh, and stream resync refresh.
- `useAgentStream(...)` continues to call `onError(...)` for live
  `final(status: "failed")` events.
- `CommandComposer` continues rendering the error above the textarea.

Do not add timeline cards or transcript rows in this phase.

### Model Visibility Policy

Do not send these runtime errors to the model by default.

Reasons:

- they are infrastructure state, not assistant semantic output
- replaying them would add cache drift and stale failure context
- local URLs/details must remain out of model context
- the model can recover from most local-model errors only after the user retries

If a future workflow needs model awareness, add a separate, sanitized runtime
system note for the next turn. Do not reuse the visible composer error text as
conversation history.

## Implementation Tasks

### Task 1: Add client-safe formatter

Add an agent-layer helper that extracts:

- `code`
- `retryable`
- sanitized `message`

from unknown errors, including `BudLocalLlmUnavailableError`.

### Task 2: Extend agent runtime state

Add optional `last_error` to the runtime snapshot and `/agent/state` response.

Do not write database rows.

### Task 3: Set and clear runtime errors in `AgentService`

In the non-cancel catch path:

- format the failure
- emit `final(status: "failed")` with sanitized error fields
- set `last_error`
- finish the turn

On success/cancel/new accepted user message, clear `last_error`.

### Task 4: Wire existing web error slot

In the existing-thread route:

- initialize `error` from `initialAgentState.last_error?.message`
- after `refreshAgentState(...)`, set or clear the route error from
  `last_error`
- keep `useAgentStream(...)` live final handling as the low-latency path

### Task 5: Update specs and tests

Update:

- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md)
- [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md)
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md)
- [../../web/src/features/threads/threads.spec.md](../../web/src/features/threads/threads.spec.md)
- [../../web/src/routes/$budId/budId.spec.md](../../web/src/routes/$budId/budId.spec.md)

Add focused tests for:

- formatter sanitization and code preservation
- runtime `last_error` set/clear behavior
- `/agent/state` includes `last_error`
- existing-thread route applies refreshed `last_error` to the composer error
- canceled turns do not create `last_error`

## Acceptance Criteria

- Rejected concurrent Bud-local ds4 requests show a user-visible composer error
  without interrupting the already-running request.
- Local LLM idle timeouts show a user-visible composer error after `/agent/state`
  refresh even if the failed final SSE event was missed.
- No failed assistant transcript rows are created.
- Runtime failure messages are not replayed into future model context.
- Browser-visible copy is sanitized and bounded.

## Deferred

Durable failed-turn artifacts remain deferred to
[phase-6-generic-agent-failure-messages.md](./phase-6-generic-agent-failure-messages.md).
Before implementing transcript rows, decide whether those rows are user-facing
only, model-facing, or represented by a separate non-message thread event.

## Implementation Notes

- Added `service/src/agent/failure-message.ts` for sanitized runtime failure formatting.
- Added `/agent/state.last_error` to `AgentRuntimeStateManager`.
- `AgentService` now emits sanitized failed `final` events and stores the same payload in runtime state for missed-event recovery.
- The existing thread route and agent stream bootstrap recovery now pipe refreshed `last_error` into the existing composer error slot.
- Runtime errors remain out of transcript rows and model replay.
