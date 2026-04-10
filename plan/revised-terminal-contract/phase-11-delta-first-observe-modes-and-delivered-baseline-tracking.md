# Phase 11: Delta-First Observe Modes And Delivered-Baseline Tracking

**Parent Plan**: [implementation-spec-follow-up.md](./implementation-spec-follow-up.md)
**Status**: Implemented

---

## Objective

Make `terminal.observe` delta-first by default, while preserving explicit full-screen and history modes, and reduce repetition across both `terminal.send` and `terminal.observe` by tracking the last delivered agent-visible baseline.

By the end of this phase:

- default `terminal.observe` returns additive delta rather than replay-heavy full capture
- explicit `screen` and `history` observe modes remain available
- send and observe share delivered-baseline tracking so repeated content is suppressed across tool calls

## Current Problem

Even when `terminal.send` correctly observes a visible change, the agent still reaches for `terminal.observe` because it needs more semantic context. Today that observe result replays too much pane history, which:

- wastes context
- can confuse the model with stale transcript
- duplicates content already shown in recent send or observe steps

## Scope

### In Scope

- default `terminal.observe` view changing to delta
- explicit observe modes for `delta`, `screen`, and `history`
- shared delivered-baseline tracking across send and observe
- runtime and service rules for when baselines are updated or cleared
- delta fallback behavior for repaint-heavy UIs

### Out Of Scope

- broad agent-prompt cleanup
- final web tool-card redesign
- final docs/spec/test pass

## Implementation Tasks

### Task 1: Define the new observe view contract

Update the runtime and protocol contract so `terminal.observe` supports:

- `delta`: default model-facing behavior
- `screen`: explicit full current rendered screen
- `history`: explicit scrollback/history request

The default should favor `delta`, not `screen`.

### Task 2: Add delivered-baseline tracking

Track the most recent agent-visible delivered capture per session/turn, regardless of whether it came from:

- `terminal.send`
- `terminal.observe`

Rules to define:

- when the baseline is set
- when it is replaced
- when it is cleared
- how it interacts with explicit `screen` / `history` requests

### Task 3: Route default observe through the shared delta engine

For default observe behavior:

- compare the current screen to the last delivered baseline when available
- otherwise compare against an immediate baseline and fall back safely
- return additive-only delta text

The goal is that a send followed by observe does not replay the same transcript block unless the model explicitly asks for a full-screen or history view.

### Task 4: Preserve explicit broader visibility modes

Keep an explicit path for:

- full rendered screen inspection
- prior history / scrollback inspection

This is necessary for:

- complex TUI layout understanding
- pagers
- broad context recovery
- debugging

### Task 5: Define repaint fallback behavior

When the UI looks repaint-heavy or the delta is too noisy:

- do not emit a pseudo-diff
- fall back to a bounded additive excerpt from the latest current screen

This fallback should still be model-friendly and additive-only.

## Validation Checklist

- [ ] default `terminal.observe` returns additive delta rather than full replay
- [ ] explicit `view: "screen"` still returns the full current screen
- [ ] explicit `view: "history"` still returns requested prior history
- [ ] a send followed by observe does not replay the same recently delivered content by default
- [ ] repaint-heavy cases fall back to a useful bounded current excerpt

## Exit Criteria

This phase is done when observe defaults to delta, explicit broader visibility modes still exist, and delivered-baseline tracking meaningfully reduces repetition across send and observe.
