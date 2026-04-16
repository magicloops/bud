# Phase 2: Interrupt Result Contract And Transport

## Goal

Replace the ambient, session-level interrupt success path with a correlated interrupt result that carries the output and readiness data produced by this specific Ctrl+C.

This phase addresses finding 3 directly and reduces the interrupt path's dependence on unrelated readiness events.

## Scope

Files expected in this phase:

- `service/src/runtime/terminal-session-manager.ts`
- `service/src/ws/gateway.ts`
- `service/src/terminal/types.ts`
- `bud/src/main.rs`
- `docs/proto.md`
- related specs/tests

## Problem Statement

The daemon already knows the interrupt-local output window:

- it captures bytes after the interrupt start offset
- it knows the final readiness assessment
- it knows the final last line

But the service currently throws most of that away and later reconstructs output via `tailOutput(...)`.

That reconstruction is weaker than the daemon's own data because it is:

- uncorrelated to this specific interrupt
- dependent on storage backfill windows and output truncation
- vulnerable to replaying older history instead of the interrupt-local bytes

## Task 1: Add A Correlated Interrupt Result Frame

### Wire Direction

Keep `terminal_interrupt` as the request, but add request correlation and a dedicated result frame.

### Request Shape

Extend `terminal_interrupt` with an optional `request_id`.

Why optional:

- old buds will ignore unknown incoming fields
- new service code can send `request_id` immediately without breaking older buds

### Result Shape

Add `terminal_interrupt_result` with fields along these lines:

- `session_id`
- `request_id`
- `submitted`
- `output_since_interrupt` (base64)
- `output_bytes`
- `last_line`
- `readiness`
- `error`

This result should represent the exact post-interrupt window, not a generic terminal tail.

## Task 2: Refactor Bud Interrupt Handling To Reuse One Detection Pass

### Change

Refactor the current Bud interrupt path so the readiness/output work can produce:

- the existing session-level readiness update needed by the rest of the system
- the new correlated interrupt result needed by the agent

### Expected Direction

- keep the existing readiness-detection logic as the source of truth
- stop treating detector output as something that can only be emitted directly to `terminal_ready`
- instead, have the detector return a reusable payload or helper result that Bud can fan out into:
  - `terminal_ready`
  - `terminal_interrupt_result`

This avoids duplicating the quiescence/activity-based detection logic.

## Task 3: Add Service-Side Pending Interrupt Tracking

### Change

Add request/response tracking in `TerminalSessionManager`, similar to `pendingObserves` and `pendingSends`.

The agent-facing path should move to a dedicated awaitable method such as:

- `requestInterrupt(...)`

while the browser-facing route can keep using a fire-and-forget wrapper such as:

- `sendInterrupt(...)`

### Expected Behavior

- agent interrupt waits on the matching `terminal_interrupt_result`
- browser interrupt route still returns quickly after dispatch success/failure
- `terminal.ready` SSE behavior remains intact via the normal readiness emission path

## Task 4: Preserve Legacy `terminal_ready` Payloads For Mixed-Version Rollout

### Why This Is Needed

New service code may deploy before all buds have the new result frame.

### Compatibility Rule

During rollout:

- the gateway must preserve the full `terminal_ready` payload, not just `assessment`
- interrupt requests should prefer `terminal_interrupt_result`
- if that result does not arrive and a newer legacy `terminal_ready` payload exists for this dispatch window, use that interrupt-local window as the fallback
- generic DB tail should no longer be the normal success path

The fallback should be explicit and temporary in design intent, even if it remains in code for safety.

## Task 5: Move Agent Interrupt Output Off Generic DB Tail

### Change

Update the agent interrupt tool path so success uses:

1. correlated `terminal_interrupt_result`, else
2. preserved legacy `terminal_ready` payload for that interrupt window during rollout

and only treats missing interrupt-local output as missing output, not as a reason to replay broad terminal history.

### Acceptance Criteria

- successful interrupt tool output matches the interrupt-local bytes from the daemon
- stale terminal history is not replayed as proof of interrupt success
- mixed-version rollout still works while older buds only emit legacy readiness

## Protocol Notes

- This phase changes Bud <-> Service terminal wire behavior, so `docs/proto.md` must be updated in the same tranche.
- The plan assumes the change can remain within terminal protocol `0.2` because the new request field is optional and the service keeps a compatibility fallback.
- If implementation proves that stricter versioning is required, document that explicitly before landing code.

## Out Of Scope For This Phase

- no redesign of `terminal_input` correlation
- no removal of session-level `terminal_ready` events
- no cancellation contract changes
