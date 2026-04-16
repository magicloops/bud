# Phase 1: Daemon Output Activity Foundation And Quiescence Engine

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Teach Bud to decide "the terminal seems settled" from the existing `pipe-pane` output stream instead of repeatedly polling `capture-pane`.

By the end of this phase:

- each terminal session tracks recent output activity in memory
- the existing output watcher updates that activity state
- `terminal.send` can wait on output quiescence locally
- `capture-pane` remains limited to the pre-send baseline and the final rendered snapshot

## Context

Bud already polls the `pipe-pane` log to stream terminal bytes upstream for the browser terminal. That gives us a cheap and already-proven signal for whether the pane is actively changing.

The current send/observe flow still spends too much work on rendered-screen polling. This phase changes the waiting primitive without changing the browser streaming plane.

## Scope

### In Scope

- extending per-session state with in-memory output-activity metadata
- updating the existing output watcher to keep those fields current
- adding a Bud-side helper that waits for output quiescence
- tuning the first-pass quiet-window defaults
- ensuring `terminal.send` uses that helper before producing its final result

### Out Of Scope

- changing how browser SSE streaming works
- redesigning service-side prompt or tool guidance
- changing `terminal.observe` semantics beyond what Bud needs internally for later phases
- building async background-job notifications

## Implementation Tasks

### Task 1: Extend terminal session state with output-activity fields

Add lightweight in-memory fields to the Bud terminal-session handle, such as:

- `last_output_at`
- `last_output_offset`
- `last_output_seq`

Use monotonic or otherwise stable timing so quiet-window math is robust.

### Task 2: Reuse the existing output watcher

Update the existing `pipe-pane` watcher so the same loop that:

- reads newly appended bytes
- advances offsets
- emits upstream `terminal_output`

also updates the new in-memory output-activity fields.

Avoid creating a second log-file polling loop for the same pane.

### Task 3: Add a shared quiescence wait helper

Implement a helper that:

- samples the shared output-activity state on a fixed interval
- detects whether the output offset has remained unchanged long enough to be considered quiet
- returns either:
  - `settled`
  - `timeout`

The first-pass defaults should remain conservative and simple:

- sample interval around `50ms`
- require `3` unchanged samples
- require a minimum quiet window around `150ms`

These numbers can be tuned after validation, but the implementation should keep them centralized rather than duplicated.

### Task 4: Move `terminal.send` onto the quiescence engine

Refactor the Bud send flow to:

1. capture the pre-send baseline
2. dispatch the input
3. wait on output quiescence
4. perform one final `capture-pane`
5. return the final rendered delta plus settle trigger

On timeout, still perform the final capture before returning.

### Task 5: Keep `capture-pane` out of the hot loop

Audit the Bud path so repeated `capture-pane` calls are no longer the normal wait strategy between dispatch and final result.

The implementation target is:

- cheap activity polling in the middle
- rendered-screen capture only at the edges

### Task 6: Add minimal diagnostics for tuning

Add debug-gated diagnostics that make quiet-window tuning easier during validation, for example:

- settle trigger (`settled` or `timeout`)
- elapsed wait time
- last observed output offset / seq

Keep these diagnostics out of the normal model-facing payload.

## Files Likely Affected

- `bud/src/main.rs`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The existing watcher state is not easy to share safely with the send path | Medium | High | Keep the added state minimal and colocated with the current session handle |
| Quiet-window tuning is too aggressive for repaint-heavy TUIs | Medium | High | Start conservative and validate against Claude Code or equivalent TUI flows |
| The implementation accidentally adds a second expensive polling loop | Medium | High | Treat reuse of the existing watcher as a hard requirement in review |

## Exit Criteria

- Bud session state includes shared output-activity metadata.
- The existing output watcher updates that metadata.
- `terminal.send` can wait for settled-or-timeout using quiescence instead of repeated `capture-pane` polling.
- Debug logs or equivalent diagnostics make quiet-window tuning possible during validation.
