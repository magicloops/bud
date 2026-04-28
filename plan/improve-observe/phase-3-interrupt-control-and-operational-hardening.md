# Phase 3: Interrupt Control And Operational Hardening

**Status**: Implemented
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)
**Priority**: High

## Goal

Make one-hour pending settled tools operationally safe.

While `terminal.send` or `terminal.observe(wait_for:"settled")` is pending, clients should continue seeing live terminal output and should have a clear interrupt path that sends `ctrl+c` and returns control to the agent.

## Scope

### In Scope

- Confirm terminal SSE output remains live while request-dispatcher promises are pending for up to one hour.
- Ensure pending tool state in `/agent/state` and `agent.tool_call` remains useful for web/mobile.
- Define the interrupt path for a human user:
  - send `ctrl+c` to the terminal
  - cancel or resolve the pending terminal wait in a controlled way
  - return control to the agent with an explicit interrupted/canceled tool result
- Ensure Bud disconnect, explicit cancel, and session close reject pending long waits promptly.
- Add debug logging for long settled waits:
  - request id
  - wait mode
  - elapsed time
  - latest output offset
  - output event count
  - readiness trigger/confidence

### Out Of Scope

- Building the mobile UI itself.
- Adding push notifications for pending tools.
- Async job wake-up after the agent turn ends.
- Replacing the existing cancellation registry.

## Product Contract

Mobile should be able to present:

- a live terminal view while the tool is pending
- an interrupt action that sends `ctrl+c`
- a state transition that gives the agent control again

The backend should not require mobile to fake completion locally. If a user interrupts, the agent stream should eventually show a real tool result/final state.

## Implemented Policy

Phase 3 uses the second interrupt ordering:

1. send `ctrl+c` through the normal `terminal_send` request path with `key: "ctrl+c"` and `wait_for: "none"`
2. reject older pending send/observe waits for the same session as `interrupted`, excluding the newly-created Ctrl+C request
3. let `TerminalToolExecutor` convert `interrupted` waits into conservative tool results with `error: "interrupted"` and `readiness.trigger: "error"`

This preserves the difference between human interrupt and agent cancel. Agent cancel still aborts the turn; human interrupt returns control to the active agent loop.

HTTP contract:

- `POST /api/threads/:threadId/terminal/interrupt`
- success response: `{ ok, session_id, submitted, rejected_pending_requests }`
- missing active terminal session: `404 { error: "no_terminal_session" }`

## Implementation Questions To Resolve

### Interrupt Ordering

There are two plausible interrupt orders:

1. send `ctrl+c`, then let the original pending settled wait observe the terminal settle
2. cancel/reject the pending tool request, then send `ctrl+c` as a separate human terminal input

Chosen policy: send the Ctrl+C request through `terminal_send`, then reject older waits while excluding the interrupt request itself. This gives the terminal a real interrupt gesture and gives the model a real `interrupted` tool result.

### Tool Result Shape

If the pending tool is interrupted, the result should be conservative. It should not look like the original command completed successfully.

Potential result indicators:

- `readiness.trigger: "canceled"` is not currently a documented readiness trigger, so avoid adding it without protocol review
- `error: "agent_canceled"` / `error: "interrupted"` may be simpler if it matches existing cancellation handling
- summary should say the wait was interrupted by the user

Implemented shape:

- `error: "interrupted"`
- `readiness.trigger: "error"`
- `readiness.ready: false`
- `readiness.hints.may_still_be_processing: true`
- send summary: "Terminal send wait was interrupted by the user after the input was sent"
- observe summary: "Terminal observe wait was interrupted by the user"

## Acceptance Criteria

- [x] A pending one-hour settled wait continues streaming terminal output to attached clients.
- [x] `/agent/state` shows the pending tool while the wait is active.
- [x] Human interrupt sends `ctrl+c` to the terminal.
- [x] Human interrupt returns control to the agent instead of leaving a one-hour promise pending.
- [x] Bud offline, session close, and agent cancel reject pending settled waits promptly.
- [x] logs make long wait state and output activity diagnosable.

## Tests

- Request-dispatcher pending send rejection for long timeout requests.
- Agent cancel while terminal send is pending.
- Bud-offline pending request rejection.
- Interrupt path route/control-boundary tests for `POST /terminal/interrupt`.
- Terminal executor tests for interrupted send/observe tool-result shape.

## Specs To Update In This Phase

- `service/src/runtime/runtime.spec.md`
- `service/src/runtime/terminal/terminal.spec.md`
- `service/src/agent/agent.spec.md`
- mobile handoff/reference docs if a first-party mobile contract doc is created
