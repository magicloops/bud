# Phase 1: Session Ownership And Offline Guardrails

**Status**: Implemented locally, staging validation pending

## Goal

Make the service treat only the current live socket/tracker for a `budId` as authoritative when updating Bud online/offline routing state.

## Why This Phase Exists

The current debug review identified the highest-confidence failure mode in [`service/src/ws/gateway.ts`](../../service/src/ws/gateway.ts):

- a new Bud socket replaces the old tracker in the shared `sessions` map
- the old tracker can still later run timeout or close cleanup
- that stale cleanup can delete the current Bud entry anyway and trigger offline side effects

That makes the backend believe the Bud is offline even though the daemon is still connected on the newer socket.

## Scope

### Service Session Ownership

- make session registration explicitly replace prior tracker ownership for the same `budId`
- clear or retire the prior tracker's timeout when a new tracker replaces it
- make timeout cleanup conditional on the tracker still being the active map entry
- make close cleanup conditional on the closing socket/tracker still being the active map entry

### Offline Side-Effect Guarding

- only run:
  - Bud status offline writes
  - terminal cache clears
  - event-buffer clears
  - terminal-session suspension
  - `terminal.bud_offline` emission

  when the tracker being cleaned up is still current

### Logging

- add targeted logs around:
  - tracker registration/replacement
  - timeout cleanup
  - close cleanup
  - whether the cleaned-up tracker was current or stale

The goal is to make a future staging incident distinguishable between:

- real Bud disconnect
- stale tracker cleanup
- socket churn without state loss

## Non-Goals

- redesigning the overall single-instance Bud routing model
- moving Bud presence into Redis or another distributed store
- changing Cloudflare Worker behavior
- changing frontend reconnect heuristics beyond what is needed to verify the backend fix

## Expected Files

- `service/src/ws/gateway.ts`
- `service/src/runtime/terminal-session-manager.ts` only if small supporting helpers or log touch-ups are needed
- `service/src/ws/ws.spec.md`
- `service/src/runtime/runtime.spec.md`

## Acceptance Criteria

- replacing a socket for the same `budId` cannot cause the older tracker to delete the newer tracker from `sessions`
- real daemon disconnects still mark the Bud offline and suspend active terminal sessions
- stale tracker cleanup is visible in logs as stale/no-op cleanup rather than performing destructive side effects
- `terminal/ensure` no longer returns `bud_offline` for a healthy reconnected Bud because of stale socket cleanup alone

## Current Progress

- `service/src/ws/gateway.ts` now:
  - clears superseded tracker timeouts during replacement
  - closes superseded sockets after replacement
  - ignores heartbeats from superseded sockets
  - limits timeout/close offline cleanup to the active tracker only
- `service/src/ws/gateway.test.ts` adds regression coverage for tracker replacement and stale cleanup suppression
- `pnpm --dir service test` passes locally
- remaining work in this phase is deployed staging validation

## Validation Notes

- exercise page refresh and normal thread use while the daemon stays connected
- force a daemon reconnect and confirm the newer socket remains authoritative
- confirm a true daemon shutdown still produces the expected offline transition
