# Phase 2: Daemon Post-Dispatch Quiescence And Readiness

**Status**: Implemented
**Parent Spec**: [implementation-spec.md](./implementation-spec.md)
**Priority**: Urgent

## Goal

Fix the Bud-side settled wait so `terminal.send` does not assess readiness around the send gesture itself.

The model-facing delta should remain:

```text
pre-send capture -> final post-wait capture
```

The quiescence/readiness baseline should become:

```text
send-key dispatch complete -> short guard -> quiescence/readiness sampling
```

## Scope

### In Scope

- Add a daemon-side post-dispatch guard, initially around `30ms`.
- Start send quiescence sampling after the guard.
- Preserve command echo in `terminal_send_result.delta.text`.
- Make settled readiness evidence-based:
  - prompt/confirmation/password/pager detection should drive high confidence
  - quiet output alone should not force `ready: true`
  - weak settled captures should keep `may_still_be_processing: true` or lower confidence
- Ensure settled waits can run for the one-hour budget supplied by the service.
- Keep `capture-pane` at the edges, not in the hot loop.

### Out Of Scope

- Removing command echo from deltas.
- Implementing a full shell-echo classifier.
- Adding exit-code semantics.
- Changing terminal output SSE transport.

## Current Risk To Address

Current `build_quiescence_assessment(...)` forces settled quiescence to:

- `ready: true`
- confidence floor `0.85`
- `may_still_be_processing: false`

This can make an echo-only Codex launch look like a completed result. The phase must decouple "output is quiet" from "terminal is ready."

## Implementation Notes

### Send Flow Target

`terminal.send` should follow this order:

1. Capture pre-send baseline for model-facing delta.
2. Dispatch text/key gesture to backend.
3. Wait `TERMINAL_SEND_POST_DISPATCH_GUARD_MS`, initially `30ms`.
4. Establish post-dispatch quiescence baseline from output offset / last-output timestamp.
5. Wait for settled quiescence or timeout.
6. Capture final screen.
7. Build delta from pre-send baseline to final capture.
8. Build readiness from final capture plus quiescence metadata.

### Quiescence Completion

The current stable-sample behavior can remain, but the completion semantics should be reviewed:

- quiet and stable output means `trigger: "settled"`
- readiness confidence comes from final capture evidence
- if final capture lacks prompt-like or input-waiting evidence, settled should not imply high-confidence ready

Implementation should avoid inventing a full semantic classifier in this phase. The practical target is to stop overstating weak evidence.

### Suggested Readiness Shape

Strong evidence:

- shell prompt, REPL prompt, confirmation prompt, password prompt, or pager marker
- use existing prompt type/hints
- confidence can remain high

Weak evidence:

- final capture changed but no prompt/input-waiting marker
- output is quiet but screen only shows command echo or generic TUI text
- confidence should be lower and `may_still_be_processing` should be true unless another detector says otherwise

Timeout:

- keep `trigger: "timeout"`
- mark `may_still_be_processing: true`
- return latest delta if capture succeeds

### Observe Behavior

`terminal.observe(wait_for:"settled")` does not have a send gesture. It can keep using the existing quiescence baseline, but should share the readiness fix so quiet output does not automatically become high-confidence ready.

## Acceptance Criteria

- [x] send deltas still include command echo when command echo is visible.
- [x] send quiescence sampling starts after dispatch plus guard.
- [x] echo-only or weak non-prompt captures do not produce high-confidence ready solely from settled quiescence.
- [x] prompt/confirmation/password/pager captures still produce useful high-confidence readiness.
- [x] timeout results still include latest delta and conservative processing hints.
- [x] `terminal.observe(wait_for:"settled")` shares the updated readiness semantics.

## Tests

Bud fake-backend tests should cover:

- shell command with prompt return: high confidence ready
- Codex-style echoed command with no prompt/result: not high confidence ready
- TUI output that changes after the dispatch guard: waits until post-guard output settles
- timeout with ongoing output: timeout readiness and latest delta
- observe settled with weak capture: does not force high-confidence ready

## Specs To Update In This Phase

- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `service/src/terminal/terminal.spec.md` if readiness semantics change in shared type docs
