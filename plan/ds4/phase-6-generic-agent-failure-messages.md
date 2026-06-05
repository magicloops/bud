# Phase 6: Generic Agent Failure Messages

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Deferred; not implemented
**Related Debug**: [../../debug/ds4-concurrency-ui-and-context-budget.md](../../debug/ds4-concurrency-ui-and-context-budget.md)
**Near-Term Alternative**: [phase-6.1-runtime-error-surfacing.md](./phase-6.1-runtime-error-surfacing.md)

---

## Objective

Make asynchronous agent failures visible in the thread UI through a generic, durable failure-message path.

The immediate trigger is Bud-local ds4 concurrency: a second request can fail quickly with `DATA_PLANE_STREAM_LIMIT_EXCEEDED` while the first local model stream continues. The fix should not special-case ds4 or Bud-local LLM availability. Any non-cancel agent failure that happens after the user message has been accepted should leave a clear user-visible artifact.

This durable transcript-row approach is deferred while the product decision
around user-facing versus model-facing failure artifacts remains open. The
near-term path is [Phase 6.1](./phase-6.1-runtime-error-surfacing.md), which
surfaces failures through runtime state and the existing composer error slot
without writing transcript rows.

By the end of this phase:

- failed turns have a durable transcript message or equivalent durable UI artifact
- missed or fast SSE failures still become visible after refresh
- raw provider/internal error text is sanitized before user display
- canceled turns remain distinct from failed turns
- no provider-specific branches are needed for ds4 concurrency failures

## Scope

### In Scope

- generic failure-message formatting for agent failures
- failed assistant transcript persistence for non-cancel failures
- runtime/SSE emission through existing `agent.message` and `final` event contracts where possible
- tests for provider-start failures that happen before any assistant text or tool call
- notification/attention behavior for failed assistant rows
- spec updates for agent runtime and thread stream behavior

### Out Of Scope

- queueing local LLM requests behind the current active ds4 request
- changing the one-stream-per-Bud local LLM concurrency limit
- adding ds4-specific failure branches or ds4-specific UI copy
- frontend-only race mitigation without a durable backend artifact
- changing cancellation semantics

## Design

### Preferred Approach

Add a generic failed-turn transcript path owned by the agent service and transcript writer.

The failure path should:

1. classify non-cancel agent failures into a client-safe error category
2. format a bounded user-facing message
3. persist an assistant row with `metadata.status = "failed"` and the current `turn_id`
4. emit the existing `agent.message` event with the serialized message
5. emit the existing `final` event with `status: "failed"`
6. finish the runtime turn only after the durable message and final event have advanced the cursor

This keeps the browser contract small because the web already consumes `agent.message` and `final`.

### Error Message Policy

Do not expose raw provider errors by default.

Suggested generic copy:

```text
Bud could not complete this turn. Try again after the current operation finishes.
```

The formatter can optionally include a stable code for debugging:

```text
Bud could not complete this turn. Try again after the current operation finishes.

Error: DATA_PLANE_STREAM_LIMIT_EXCEEDED
```

Provider request bodies, local URLs, API keys, stack traces, and raw daemon error details must not be displayed.

### Notification And Attention Policy

Avoid treating failed assistant rows as normal `assistant_completed` attention until product semantics are explicit.

Two implementation choices are acceptable:

- add a transcript-writer method for failed assistant rows that emits `agent.message` and `final` but skips assistant-completed push/outbox insertion
- generalize `recordFinalAssistant(...)` so attention/push behavior is controlled by status

The lower technical-debt path is to make status-aware final assistant persistence generic.

## Implementation Tasks

### Task 1: Add client-safe failure formatting

Add a small helper in the agent layer, for example:

```typescript
formatAgentFailureMessage(error: unknown): {
  message: string;
  code: string;
  retryable: boolean;
}
```

Rules:

- preserve stable error codes when available
- default to `AGENT_FAILED`
- treat cancel/abort errors outside this helper or return no failure message
- bound message/code lengths
- omit stack traces and provider payloads

### Task 2: Persist failed assistant rows

Add a transcript writer path for failed final assistant rows.

Required metadata:

- `status: "failed"`
- `turn_id`
- `segment_kind: "final"`
- selected model/reasoning metadata
- stable `error_code`
- `retryable`

Avoid notification/outbox side effects unless explicitly chosen.

### Task 3: Use failed row path in `AgentService`

In the non-cancel catch path:

- clear cancellation state and reject pending user-question waits as today
- build the client-safe failure message
- persist and emit the failed assistant row
- finish the runtime turn after the durable state is observable
- preserve backend structured logs with raw error diagnostics for developers

### Task 4: Keep canceled turns separate

Canceled turns should continue to emit `final(status: "canceled")` and should not create a failed assistant row.

### Task 5: Update specs and docs

Update:

- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md)
- [../../service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md) if `/agent/state` semantics change
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md) if stream event details change
- [../../web/src/features/threads/threads.spec.md](../../web/src/features/threads/threads.spec.md) if UI reconciliation behavior changes

## Test Plan

- unit test failure-message formatting
- agent-service test: provider invocation throws before any assistant text and records one failed assistant message
- agent-service test: canceled turn does not record a failed assistant message
- transcript-writer test: failed rows emit `agent.message` plus `final(status: "failed")`
- thread-message-state or route-level test if UI reconciliation needs adjustment

## Acceptance Criteria

- A fast asynchronous agent failure leaves a visible thread message after refresh.
- The failed message path works for any provider, not only ds4.
- The original in-progress ds4 stream is not interrupted by the rejected concurrent request.
- Browser-visible error text is sanitized.
- Existing successful and canceled turns keep their current behavior.

## Open Questions

- Should failed assistant rows update `thread.last_message_preview`? Recommendation: yes, because the failure is the latest visible transcript artifact.
- Should failed assistant rows count as unread attention? Recommendation: no for push/outbox until product copy is decided, but yes for visible transcript chronology.
- Should retryable failures render differently in the browser? Recommendation: store `retryable` in metadata first; defer UI styling.
