# Phase 9: Web Regression Validation Before Structural Fixes

**Status**: Completed

## Objective

Validate the post-closeout web regression before making any structural code changes.

The current symptoms are:

- opening an existing thread can leave the terminal showing `Bud offline`
- switching threads updates the URL but the visible UI stays on the first thread
- the failing bundle still shows terminal SSE connectivity and heartbeats

This phase existed to prove whether the issue was:

- a real stale-route / stale-state bug in `ThreadView`
- a parent-route match/selection bug
- or a dev-bundle / Fast Refresh exposure effect from the latest module split

before the codebase took on another structural refactor.

## Outcome

Completed.

This phase produced:

- a small, explicit instrumentation pass
- a validated root-cause category with evidence
- a recommendation for the narrowest safe fix direction

Validated result:

- the primary issue was not a true route-param/state regression and not the context split itself
- in local dev, the browser was sending both short-lived fetches and each thread tab's two long-lived SSE streams through the Vite origin
- same-browser multi-tab usage could therefore stall loader and terminal mutation requests while the existing SSE streams stayed alive
- moving local browser API/SSE traffic to `VITE_API_BASE_URL=http://localhost:3000` and allowing `http://localhost:5173` via service CORS resolved the breakage
- the stale `Bud offline` overlay behavior remains a secondary frontend/runtime follow-up, but it was not the primary root cause of the reproduced regression

## Scope

### In scope

- temporary diagnostic instrumentation in the affected web routes
- targeted manual reproduction in the current local dev bundle
- comparison of route params, loader data, derived thread state, and terminal state-machine transitions
- validation of whether a hard refresh / dev-server restart changes the outcome
- updating the existing debug notes with concrete findings and the validated fix direction

### Out of scope

- structural route rewrites
- provider/context redesign
- service/backend contract changes
- speculative cleanup that is not needed for validation

## Current Findings

From the completed validation pass:

- the regression window was only one commit: `cd267c4`
- same-browser multi-tab repro broke even across different Buds and different threads
- a different browser profile against the same backend continued to work
- the Network tab showed stalled `terminal/ensure` / `terminal/input` style fetches while the existing SSE streams remained connected
- switching local browser traffic to `VITE_API_BASE_URL=http://localhost:3000` resolved the issue

That validated local same-origin proxy transport pressure as the primary cause, not a structural route/provider regression.

## Validation Work

### 1. Confirm whether `ThreadView` sees the new thread param

Add temporary logging in `web/src/routes/$budId/$threadId.tsx` to capture:

- `threadId`
- `initialThread.thread_id`
- `currentThread.thread_id`

Capture the values:

- on first thread open
- immediately after switching to a different thread
- after the route appears visually stuck

Purpose:

- prove whether the route instance is receiving the new param and new loader payload
- distinguish stale render state from stale route-param resolution

### 2. Confirm whether terminal state is stale rather than freshly computed

Add temporary logging around the thread-change branch in the terminal SSE effect in `web/src/routes/$budId/$threadId.tsx` to capture:

- `threadId`
- previous `lastConnectedThreadIdRef.current`
- `terminalState`
- `terminalConnection`
- `currentSessionIdRef.current`

Log immediately:

- before the thread-change reset branch
- after the reset branch runs
- when `recoverTerminalSession(...)` is called
- when `recoverTerminalSession(...)` resolves

Also log whether `recoverTerminalSession(...)` is being called with the newly selected `threadId` and current session record, not a stale one.

Purpose:

- prove whether the offline overlay is stale carry-over state
- prove whether recovery is targeting the selected thread or a stale thread/session pair

### 3. Confirm whether the parent route match is reporting the right active thread

Add temporary logging in `web/src/routes/$budId.tsx` around the `useMatches()` / `activeThreadId` calculation to capture:

- the raw `matches` route IDs and params
- the resolved `activeThreadId`
- the clicked target thread ID

Purpose:

- prove whether the route shell is deriving the active thread correctly
- separate a thread-panel selection bug from a `ThreadView` state bug

### 4. Validate whether the issue survives a clean bundle lifecycle

Repeat the repro after:

- a full hard refresh of the failing tab
- a dev-server restart with a fresh page load

Interpretation:

- if the issue still reproduces, the leading read is a real route-state bug
- if the issue disappears after a clean lifecycle, the provider split / Fast Refresh / module-graph hypothesis rises materially in confidence

### 5. Summarize the validated root-cause category before proposing fixes

At the end of this phase, the debug note should answer:

1. Is the route param changing correctly?
2. Is the loader payload changing correctly?
3. Is `currentThread` changing correctly?
4. Is terminal state being reset on thread change/recovery, or is stale state surviving?
5. Does the bug survive a clean bundle lifecycle?

No structural fix plan should be proposed until those five questions are answered with evidence.

## Expected File Areas

- `web/src/routes/$budId.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- `debug/web-thread-navigation-and-terminal-offline-regression.md`
- `plan/refactor-service/progress-checklist.md`
- `plan/refactor-service/implementation-spec.md`
- `plan/refactor-service/refactor-service.spec.md`
- `bud.spec.md`

## Exit Criteria

- temporary diagnostics are scoped and targeted rather than broad
- there is a clear evidence-backed answer for whether the bug is:
  - stale `ThreadView` state
  - stale parent-route match state
  - or dev-bundle / Fast Refresh exposure
- the debug note is updated with the observed results
- the next fix plan is based on validated behavior rather than hypothesis alone
