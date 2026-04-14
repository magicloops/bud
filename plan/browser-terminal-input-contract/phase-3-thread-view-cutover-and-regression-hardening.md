# Phase 3: Thread View Cutover And Regression Hardening

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Integrate the new browser input path cleanly into the existing thread terminal lifecycle so we do not regress reconnect, view toggles, resize, focus, or history behavior while removing `onData`.

By the end of this phase:

- the new input path is fully integrated into the thread route
- listener lifecycle is correct across mount/unmount/reconnect/view changes
- existing terminal recovery behavior still works
- the route remains understandable rather than accreting more ad hoc terminal branching

## Current Problem

The thread route already owns:

- xterm initialization
- fit/resize
- terminal SSE connect/reconnect
- history backfill
- recovery and state overlays
- input batching and `/terminal/input` submission

Swapping the input source without rechecking these behaviors is risky, because subtle regressions may only appear during reconnects, focus changes, or view toggles.

## Scope

### In Scope

- thread route listener lifecycle
- connection-state gating for the new input path
- focus and click-to-focus behavior
- view-mode interaction
- reconnect/history/resize regression checks

### Out Of Scope

- new service/Bud transport work
- PTY-backed browser attach
- expanded feature support beyond the locked phase-1 catalog

## Implementation Tasks

### Task 1: Route integration cleanup

Make the new browser input path fit the existing route architecture cleanly.

Requirements:

- no duplicate event listeners after rerenders
- no stale closures during reconnect or thread switches
- cleanup on unmount remains correct

### Task 2: Connection and view-mode gating

Ensure terminal input only submits when appropriate.

Expected guards:

- only when the terminal connection is logically usable
- only when the terminal view is active
- avoid accidental submission during disconnected/reconnecting states

### Task 3: Focus behavior

Recheck focus interactions now that outbound input is no longer tied to `onData`.

Validate:

- click-to-focus still works
- initial terminal focus behavior still works
- refocus no longer causes leaked input

### Task 4: Preserve resize/history/recovery behavior

The input cutover should not affect:

- resize synchronization
- SSE output streaming
- history backfill
- terminal recovery via `terminal/ensure`

Revalidate all of these after the cutover even if the implementation change is web-only.

### Task 5: Keep the code path understandable

If the route becomes harder to reason about, extract the translator and related listener glue rather than piling more inline branches into [`$threadId.tsx`](../../web/src/routes/$budId/$threadId.tsx).

## Suggested Validation

- [ ] Thread switch cleanup does not leave stale listeners behind.
- [ ] Reconnect and recovery still work after disconnecting and restoring the terminal session.
- [ ] Resize still works after window resizes and panel toggles.
- [ ] History backfill still renders correctly on attach/recovery.
- [ ] Focus and click-to-focus still behave normally.
- [ ] The input path does not fire while disconnected or hidden.

## Exit Criteria

This phase is done when the new browser input path behaves as a normal part of the existing thread terminal lifecycle rather than as a fragile special case.
