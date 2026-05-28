# Phase 3: Transport Tool Results And Recovery

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Make Bud transport loss during an active turn recoverable.

By the end of this phase:

- terminal and web-view transport failures become structured tool results
- the agent loop continues after expected transport failures
- environment is refreshed before provider and tool steps
- Bud-specific tools can be restored later in the same turn if the Bud reconnects

## Problem

Phase 2 handles Bud-offline startup, but a normal online turn can still lose transport after the model has already been offered Bud-specific tools.

Examples:

- Bud disconnects while `terminal_send` is waiting for a settled result
- Bud disconnects before `terminal_observe`
- web-view proxy transport disappears during `web_view_open`
- service restart or daemon reconnect makes the previous transport snapshot stale

These should not automatically fail the whole agent turn. They should become tool results the model can reason over.

## Design

### Environment refresh points

Refresh environment at these boundaries:

- before each provider invocation
- before dispatching a Bud-specific tool
- after any Bud-specific transport failure

This enables:

- offline provider calls to omit Bud tools
- normal provider calls to include Bud tools when online
- tools to fail quickly if transport disappears after the provider request
- later provider calls to regain Bud tools if the Bud reconnects

### Structured tool result shape

Tool results should include:

```json
{
  "ok": false,
  "error": "bud_offline",
  "code": "BUD_DISCONNECTED",
  "retryable": true,
  "summary": "The Bud disconnected before terminal input could be delivered."
}
```

Use existing canonical codes where possible:

- `BUD_DISCONNECTED` for known offline/disconnected transport
- `TIMEOUT` for request/response waits that time out
- `EXEC_FAILED` for transport dispatch failures that are not clean offline or timeout cases
- `CANCELED` for explicit user/agent cancellation

Avoid converting:

- provider errors
- database write failures
- malformed model tool payloads
- route authorization failures
- internal invariant/contract errors

Those should remain normal failures.

## Implementation Tasks

### Task 1: Add transport-error normalization

Add a helper that maps known lower-level failures into client/model-safe tool result metadata.

Inputs:

- thrown `Error`
- failed terminal/session result
- web-view/proxy transport result
- timeout/cancel markers

Outputs:

- `is_transport_error`
- `code`
- `error`
- `retryable`
- `summary`

### Task 2: Update terminal tool executor

Handle transport failures around:

- session ensure
- terminal send
- terminal observe
- pending wait rejection from Bud disconnect
- request timeout

For transport failures:

- return a normal tool result object
- persist a tool row through existing transcript writer paths
- emit `agent.tool_result`
- do not throw out of the agent loop

### Task 3: Update web-view tool executor

Handle transport/proxy failures around:

- open
- close
- list
- local proxy capability checks
- WebSocket proxy availability where applicable

For transport failures:

- return a normal tool result object
- include web-view-specific metadata if useful
- do not expose private grants, cookies, or daemon stream ids

### Task 4: Refresh tool catalog per provider step

Before each model invocation:

1. resolve current environment
2. update runtime state environment
3. choose tool catalog from current environment
4. add environment prompt context when Bud tools are unavailable

If a previous tool failed while offline but the Bud is online now, the next provider request should receive the normal tool catalog.

### Task 5: Tests

Add tests for:

- terminal send offline after normal startup becomes `BUD_DISCONNECTED` tool result
- terminal observe timeout becomes `TIMEOUT` tool result
- generic terminal dispatch failure becomes `EXEC_FAILED` tool result
- web-view transport failure becomes a structured tool result
- transport tool result is persisted and emitted
- agent loop continues after transport tool result
- environment refresh removes Bud tools after disconnect
- environment refresh restores Bud tools after reconnect before a later provider step
- provider/db/validation errors still fail normally

## Exit Criteria

Phase 3 is complete when a Bud can disconnect and reconnect during a single agent turn without forcing the entire turn to fail or remain permanently offline.
