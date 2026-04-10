# Phase 7: Runtime Settled Wait And Observation Engine

**Parent Plan**: [implementation-spec-follow-up.md](./implementation-spec-follow-up.md)
**Status**: Implemented

---

## Objective

Replace the current blind `screen_stable` behavior with a runtime wait engine that starts immediately and can classify fast interactive behavior as either `changed`, `settled`, or still processing.

By the end of this phase:

- send/observe waits start observing immediately rather than after a fixed blind delay
- the runtime can detect both quick changes and quick settling
- service and Bud timeouts are aligned so normal results do not arrive as orphans

## Current Problem

The current `screen_stable` path waits too long before it even looks at the screen and then samples too slowly. That creates two bad outcomes:

- fast TUI startup is invisible
- the service can time out before Bud returns, producing orphaned results

This is not a good fit for Claude Code, REPLs, or other fast interactive programs.

## Scope

### In Scope

- Bud-side change/settled detection
- service-side timeout alignment and grace windows
- shared capture/fingerprint helpers used by `terminal.send` and `terminal.observe`
- default wait mapping for the agent path

### Out Of Scope

- unrelated shell quiescence behavior for `terminal.exec`
- browser UI changes outside what the new result shape requires

## Contract Direction

Recommended wait modes for the agent path:

- `none`: no extra waiting beyond the default fast post-send observation
- `changed`: return as soon as the screen differs from the baseline
- `settled`: start immediately, track changes, and return once the UI is quiet for a short window

`screen_stable` should not remain the primary agent-facing mental model if it still implies a long blind wait.

## Implementation Tasks

### Task 1: Introduce baseline fingerprint capture

Before or during interactive dispatch, capture or reuse a recent baseline screen fingerprint so the runtime can compare what happened after the send.

### Task 2: Implement immediate-start `changed`

The runtime should be able to return quickly when:

- new content appears
- input echoes into the pane
- the TUI redraws immediately

### Task 3: Implement immediate-start `settled`

`settled` should:

- start sampling right away
- use short intervals
- detect changes as they happen
- return once the screen has been quiet for a short configurable period

This is a better match for fast interactive programs than the current multi-second delay model.

### Task 4: Reuse the same engine for explicit observe

`terminal.observe` should use the same capture and waiting machinery so send and observe semantics do not drift apart.

### Task 5: Align service and Bud timeout behavior

The service should not timeout in the normal window before Bud has a fair chance to finish the requested wait.

Address:

- service-side timeout budgeting
- Bud-side internal timeout accounting
- grace windows for late-arriving but valid results
- logging for late/orphaned outcomes

### Task 6: Avoid redundant captures where possible

The current observe path can capture more than once after the wait. Tighten that so the engine captures only what it needs for:

- readiness classification
- returned observation payload

## Validation Checklist

- [x] fast TUI startup can be detected without a multi-second blind delay
- [x] quick REPL responses can be classified as settled within one send call
- [x] long-running interactive work can still surface as processing and steer toward observe
- [x] service and Bud timeouts no longer produce normal orphaned results
- [x] send and observe use consistent capture/wait semantics

## Implementation Notes

- Bud now captures or reuses a baseline screen before interactive waits so `changed` can react to the first visible redraw.
- `changed` / `settled` now start immediately, poll every `100ms`, and use a `300ms` quiet window for `settled`.
- `terminal.observe` reuses the wait capture instead of always issuing a second `capture-pane`.
- The service now gives `terminal.observe` a local `1000ms` grace window beyond the daemon timeout to reduce normal orphaned results.
- Timeout assessments from the new screen wait helper remain conservative instead of being treated as successful readiness just because the final screen resembles a prompt.

## Exit Criteria

This phase is done when the runtime wait behavior matches fast real-world interactive programs instead of forcing every TUI through a long blind stability loop.
