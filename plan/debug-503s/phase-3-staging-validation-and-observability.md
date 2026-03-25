# Phase 3: Staging Validation And Observability

## Goal

Verify the fix against the real staging environment and leave enough observability behind to distinguish real disconnects from client churn.

## Why This Phase Exists

The bug was observed only after the public staging stack was live behind Cloudflare and Render. Local correctness is necessary but not sufficient; the fix must be validated where the original symptom occurred.

## Scope

### Staging Validation Matrix

- active thread with terminal output streaming
- page refresh during active terminal use
- two-tab and three-tab browser scenarios
- daemon reconnect while the thread page stays open
- true daemon shutdown / restart
- claim page open in a second tab while thread activity continues, to confirm whether it is a red herring

### Observability

- capture service logs for:
  - tracker registration/replacement
  - stale cleanup ignored
  - active cleanup performed
- correlate frontend console/network behavior with:
  - terminal SSE state
  - `terminal/ensure` retries
  - Bud online/offline events
- review Cloudflare Worker metrics again after the fix to see whether `Cancelled` and `Response Stream Disconnected` rates fall to a more expected background level

### Documentation

- update the debug note with post-fix findings if the behavior changes materially
- update deployment validation docs if the issue reveals staging-specific operator guidance worth preserving

## Non-Goals

- broad staging performance work
- changing the Cloudflare Worker routing contract unless validation shows the router itself is still implicated

## Expected Files

- `debug/staging-false-bud-offline-terminal-503s.md`
- `plan/debug-503s/validation-checklist.md`
- optionally `plan/deploy/validation-checklist.md` if operator-facing staging guidance needs to change

## Acceptance Criteria

- refresh, reconnect, and multi-tab tests pass on `https://staging.bud.dev`
- the Bud daemon remains routable through `/ws` after reconnects
- terminal SSE remains stable without repeated false-offline `503` loops
- Cloudflare Worker disconnect metrics are explainable as ordinary client churn, not evidence of unresolved backend state loss

## If Phase 1 Is Not Sufficient

Use the same staging runs to decide whether Phase 2 needs to start immediately:

- if `terminal/ensure` `503` loops disappear, hold Phase 2 unless smaller reconnect churn still remains
- if healthy Buds still appear offline, capture service logs and browser network traces first, then inspect the frontend status-gap reconnect logic and connected-SSE recovery polling
- only treat Cloudflare Worker behavior as the next primary suspect if service logs show the active tracker remained intact during the failure
