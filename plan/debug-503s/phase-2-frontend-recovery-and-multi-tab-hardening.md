# Phase 2: Frontend Recovery And Multi-Tab Hardening

## Goal

Reduce avoidable reconnect churn in the thread UI once the backend no longer produces false-offline state.

## Why This Phase Exists

The current frontend logic in [`web/src/routes/$budId/$threadId.tsx`](../../web/src/routes/$budId/$threadId.tsx) can amplify backend disconnect signals:

- `recoverTerminalSession(...)` treats `bud_offline` as a reconnect/offline transition and will keep retrying `terminal/ensure`
- while SSE is still connected, a polling loop retries recovery every 2 seconds
- `handleStatus(...)` treats a gap greater than 5 seconds as `service_restart_detected`, even though the production terminal stream heartbeat is also 5 seconds

That makes the UI noisier and increases the chance of repeated `terminal/ensure` traffic during marginal timing or stale-state events.

## Scope

### Recovery Heuristics

- review whether `handleStatus(...)` should infer service restart from a `> 5000 ms` gap at all
- if that path remains, make the threshold clearly larger than the production heartbeat cadence
- ensure the reconnect path uses authoritative signals first:
  - closed/error SSE
  - explicit `terminal.bud_offline`
  - confirmed `terminal/ensure` failure after the backend fix

### Recovery Loop Behavior

- confirm the connected-SSE recovery poll does not hammer `terminal/ensure` during ordinary quiet periods
- keep recovery responsive for genuine disconnects without generating duplicate retries

### Multi-Tab Posture

- validate that multiple tabs on the same thread/Bud do not cause conflicting local UI state transitions
- avoid letting stale or buffered status events override a newer disconnected/reconnected state

## Non-Goals

- introducing a cross-tab coordination layer
- redesigning the thread route architecture
- changing the browser auth/session model

## Expected Files

- `web/src/routes/$budId/$threadId.tsx`
- `web/src/routes/$budId/budId.spec.md`
- optionally `web/web.spec.md` if the route behavior changes materially

## Acceptance Criteria

- the thread page no longer enters repeated `terminal/ensure` retries during normal healthy operation
- a normal heartbeat/status timing gap does not trigger a false reconnect
- real disconnects still recover without manual page refresh
- multi-tab usage no longer appears to destabilize the terminal view in staging

## Validation Notes

- keep two or more tabs open on the same thread while sending commands
- refresh one tab while the other remains open
- confirm the terminal remains usable without the Bud flipping offline spuriously
