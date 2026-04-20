# Phase 9: Web Regression Validation Before Structural Fixes

**Status**: Planned

## Objective

Validate the post-closeout web regression before making any structural code changes.

The current symptoms are:

- opening an existing thread can leave the terminal showing `Bud offline`
- switching threads updates the URL but the visible UI stays on the first thread
- the failing bundle still shows terminal SSE connectivity and heartbeats

This phase exists to prove whether the issue is:

- a real stale-route / stale-state bug in `ThreadView`
- a parent-route match/selection bug
- or a dev-bundle / Fast Refresh exposure effect from the latest module split

before the codebase takes on another structural refactor.

## Outcome

Not started.

The expected output of this phase is:

- a small, explicit instrumentation pass
- a validated root-cause category with evidence
- a recommendation for the narrowest safe fix direction

## Scope

### In scope

- temporary diagnostic instrumentation in the affected web routes
- targeted manual reproduction in the current local dev bundle
- comparison of route params, loader data, derived thread state, and terminal state-machine transitions
- validation of whether a hard refresh / dev-server restart changes the outcome
- updating the existing debug note with concrete findings

### Out of scope

- structural route rewrites
- provider/context redesign
- service/backend contract changes
- speculative cleanup that is not needed for validation

## Current Findings

From the current debug review:

- the regression window is only one commit: `cd267c4`
- the browser is still receiving:
  - agent SSE connection
  - terminal SSE connection
  - `terminal.bud_offline`
  - `terminal.bud_online`
  - repeated `terminal.status` events with `state: 'ready'`
- the thread route is currently logging that it is ignoring those status events because local connection state remains `reconnecting`
- the latest diff did not change the terminal reconnect/offline state machine directly

That makes a local React route-state stall the leading hypothesis, but it is not proven yet.

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
