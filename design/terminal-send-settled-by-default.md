# Design: `terminal.send` Settled-By-Default Via Output Quiescence

**Status:** Draft
**Created:** 2026-04-16
**Related:**
- [`review/terminal-send-result-flow-review.md`](../review/terminal-send-result-flow-review.md)
- [`design/terminal-send-confirmation-and-fast-observe.md`](./terminal-send-confirmation-and-fast-observe.md)
- [`design/terminal-delta-observation-and-minimal-tool-payloads.md`](./terminal-delta-observation-and-minimal-tool-payloads.md)
- [`design/reconsidering-terminal-exec-vs-terminal-send.md`](./reconsidering-terminal-exec-vs-terminal-send.md)

---

## Summary

Bud should simplify the common agent path by making `terminal.send` behave as:

- send input
- wait locally until terminal output appears settled
- return one result with the settled screen delta
- if a larger timeout is reached, return the latest delta plus a timeout/processing assessment

The key design change is to make **pipe-pane output quiescence** the primary settle detector and use `capture-pane` only for:

- the pre-send baseline
- the final rendered snapshot used to build the delta

This keeps the current architecture mostly synchronous, removes most immediate `terminal.observe` follow-ups, and avoids putting wait-strategy selection burden on the model.

## Background

The current tmux-backed terminal architecture has two separate observation mechanisms:

1. **Pipe-pane output streaming**
   - Bud pipes pane output to a session log
   - an output watcher polls that log and sends `terminal_output` frames upstream
   - this is already the normal browser terminal data plane

2. **Capture-pane screen observation**
   - Bud captures rendered screen state on demand
   - `terminal.send` and `terminal.observe` use this for readiness/delta work

This split is directionally correct, but the current agent flow still makes the model do too much work:

- `terminal.send` often returns before the useful final state is available
- the model then calls `terminal.observe`
- sometimes it does that more than once

That wastes:

- tool-call count
- model context window
- latency
- API cost

At the same time, the model should not be expected to choose the perfect wait mode up front for every send.

## Problem Statement

We want the common agent case to feel synchronous:

- the model sends input
- Bud waits locally while the terminal is actively changing
- the model gets control back once the result appears settled

Today that is not the default experience because the wait policy is still too exposed and too capture-pane-centric.

We need a design that:

- works well for quick shell commands
- works well for TUIs and REPLs that stream output and then settle
- keeps long-running jobs honest by timing out into a partial-progress result

without forcing the model to predict those categories ahead of time.

## Goals

- Make `terminal.send` the strong default tool for synchronous terminal interaction.
- Remove most immediate `terminal.observe` follow-ups from normal agent flows.
- Use the existing pipe-pane output path as the primary signal for "still active" vs "quiet".
- Keep capture-pane out of the hot polling loop.
- Return useful partial state on timeout instead of forcing repeated observe polling.
- Keep `terminal.observe` available as the longer-wait and advanced-inspection escape hatch.

## Non-Goals

- Providing authoritative shell exit codes through tmux.
- Solving async/background job wake-up in this phase.
- Supporting multiple concurrent async terminal jobs in one agent turn.
- Replacing tmux with a direct PTY implementation.
- Eliminating capture-pane entirely.

## Design Principles

### 1. The model should not need foresight

The model should not have to predict whether a send is:

- a quick shell command
- a TUI startup
- a long-running job

The common default should be correct enough without that prediction.

### 2. Use cheap signals for waiting, expensive signals for interpretation

The system already has a cheap activity signal:

- pipe-pane output bytes / offset changes

It already has an expensive interpretation tool:

- capture-pane rendered screen snapshots

The settle detector should primarily use the first, not the second.

### 3. "Settled" means visually quiet, not semantically successful

Bud cannot currently prove shell success under tmux the way a direct subprocess API could.

So the design target is:

- "the terminal has stopped actively changing"

not:

- "the command definitely succeeded"

That is still sufficient for improving the common agent loop.

## Proposed Semantics

## `terminal.send`

`terminal.send` should mean:

1. capture a pre-send baseline
2. dispatch the input
3. wait until output appears settled
4. capture the final screen
5. return the delta and readiness

Default behavior:

- implicit `wait_for: "settled"`
- default timeout around `30000ms`

Timeout behavior:

- return the latest available delta against the pre-send baseline
- mark readiness as timeout/processing
- let the model choose whether to wait longer or intervene

### Model-facing simplification

The model-facing guidance should stop encouraging explicit send wait-mode selection in normal use.

The preferred model contract should become:

- use `terminal.send` normally
- use `terminal.observe(wait_for:"settled")` only when a longer or more specialized wait is needed

## `terminal.observe`

`terminal.observe` remains the advanced waiting and inspection tool.

Recommended role:

- longer waits than the default `terminal.send` timeout
- explicit follow-up after a send timeout
- full-screen/history inspection when delta is insufficient
- future "check back later" workflows

It should continue supporting:

- `view: "delta" | "screen" | "history"`
- `wait_for: "settled"` with longer timeout budgets

## Daemon Design

### Reuse the existing output watcher

Bud already polls the pipe-pane log and maintains output offsets for streaming.

Instead of adding a second filesystem polling loop, the daemon should extend the existing per-session watcher state with small in-memory activity fields such as:

- `last_output_at`
- `last_output_offset`
- `last_output_seq`

Those values should be updated inside the existing watcher whenever new bytes are observed.

### Settle detection should watch output quiescence

After `terminal.send` dispatches input, the wait loop should poll this in-memory activity state rather than calling `capture-pane` repeatedly.

Recommended settle rule:

- sample the latest output offset every `50ms`
- require `3` consecutive unchanged samples
- require a minimum quiet window of roughly `150ms`

Equivalent interpretation:

- if the output offset has not changed for ~150ms, the terminal is probably settled

This is the right level of confidence for the current tmux design without invoking `capture-pane` in the hot path.

### Keep capture-pane at the edges

`capture-pane` should still be used:

- once before dispatch, to create the baseline
- once after settle or timeout, to capture the rendered state used for the returned delta

That means capture-pane remains essential, but it is no longer responsible for driving the waiting loop itself.

### Why final capture still matters

Byte silence alone answers:

- "has the terminal stopped emitting output?"

It does **not** answer:

- "what is the rendered terminal state now?"
- "did the send visibly change anything?"

That is why the final capture remains necessary even when output quiescence becomes the primary settle detector.

The combination gives us:

- cheap waiting
- useful final interpretation

## Timeout Semantics

Timeout should not be treated as a hard failure in the common case.

If the timeout is reached before settle:

1. perform one final capture
2. build the delta against the pre-send baseline
3. return readiness with:
   - `trigger: "timeout"`
   - `may_still_be_processing: true`

This gives the model a single meaningful decision point:

- wait longer with `terminal.observe`
- or intervene

instead of forcing repeated observe polls just to learn that the terminal is still busy.

## Why Output Quiescence Is The Right Primary Signal

Compared to repeated capture-pane polling, output quiescence has better properties for the current tmux architecture:

- it is cheaper
- it naturally tracks spinners/progress bars and streaming TUI output
- it already exists in the browser terminal data path
- it aligns shell commands and TUIs under one activity model

Examples:

- a quick shell command prints, returns a prompt, and then goes quiet
- a TUI streams progress bytes while thinking and then goes quiet when it reaches a stable prompt/menu/result state
- a long-running script keeps emitting bytes and therefore keeps resetting the quiet window

## Risks And Mitigations

### 1. False settle during bursty output

A program that prints in bursts with pauses may appear settled temporarily.

Mitigations:

- require multiple unchanged samples
- require a minimum quiet window
- return timeout/processing conservatively when uncertainty remains
- keep `terminal.observe(wait_for:"settled")` for explicit longer waits

### 2. Quiet but unchanged screen

A send could result in:

- no new output
- no meaningful rendered change

In that case the final capture delta may remain empty or unchanged.

That should be treated as ambiguous rather than successful. This is another reason the final capture is still necessary.

### 3. Polling interval tradeoff

The current pipe-pane watcher polls the log file every `50ms`.

That is already much cheaper than capture-pane polling. If latency still feels high, it may be reasonable to lower that modestly, but the design should avoid ultra-aggressive capture loops such as `1-10ms`.

The important point is:

- pipe-pane log polling can be moderately frequent
- capture-pane should stay out of the hot loop

## Protocol And Service Implications

### Bud ↔ service behavior

No fundamental architecture change is required.

The main changes are:

- default `terminal.send` semantics shift to settled-by-default
- send timeout becomes longer
- the daemon uses output quiescence to decide when to answer
- timeout results return partial/latest state instead of a thinner fast-observe result

### Agent guidance

The service prompt/tool guidance should simplify to:

- use `terminal.send` normally
- assume it waits for the settled result by default
- use `terminal.observe(wait_for:"settled")` only for longer waits or special cases

That reduces agent-side cognitive overhead and should collapse many current send-observe chains into a single send.

## Validation Scenarios

1. Run a quick shell command like `pwd` or `git status` and confirm `terminal.send` returns the settled result in one tool call.
2. Launch a TUI or REPL that emits startup/progress output and confirm the quiet window resets while bytes continue flowing.
3. Send input to Claude Code and confirm the send call returns once the screen reaches a stable prompt/result/confirmation state.
4. Run a long script that exceeds the default timeout and confirm the result returns latest delta plus timeout/processing readiness.
5. Run a bursty command and confirm it does not settle on a single brief pause.
6. Send input that is ignored and confirm the final delta is empty or ambiguous rather than falsely successful.

## Alternatives Considered

### Capture-pane-driven settle detection

This was the natural first implementation because it directly reflects rendered state.

Why it is not the preferred primary detector:

- it is more expensive
- it is slower in the hot path
- it duplicates work already implied by the pipe-pane stream

### Model-selected wait profiles

This would expose categories like:

- shell command
- startup/TUI
- background job

Why it is not preferred for now:

- it puts foresight burden on the model
- it reintroduces avoidable complexity
- the common case should work without category prediction

### True async callbacks / wake-ups

This is still the long-term solution for multi-minute or multi-hour jobs.

Why it is deferred:

- it changes the turn lifecycle materially
- it is not required to improve the common synchronous path now

## Open Questions

1. Should the existing pipe-pane watcher stay at `50ms`, or should it move modestly lower for lower-latency settle detection?
2. Is `3` unchanged samples at `50ms` plus a `150ms` quiet window sufficient, or should the first implementation use a slightly wider quiet window like `200ms`?
3. Should model-facing `terminal.send` continue exposing `wait_for`, or should the service stop advertising that knob while preserving it internally?

## Recommendation

Adopt a settled-by-default `terminal.send` design built on **output quiescence first, capture-pane second**:

- output quiescence drives the wait loop
- capture-pane provides the baseline and final rendered delta
- timeout returns partial/latest state rather than forcing repeated observe calls
- `terminal.observe` becomes the longer-wait escape hatch

This is the simplest next step that meaningfully improves the current tmux-based architecture without taking on async job orchestration yet.
