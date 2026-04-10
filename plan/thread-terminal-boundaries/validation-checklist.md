# Thread Terminal Boundaries Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Browser Transport Boundary

### Classification

- [ ] Browser terminal outbound traffic is classified as `human` or `emulator_protocol`.
- [ ] Public xterm `onData(...)` is no longer forwarded directly from the thread route to backend terminal input.
- [ ] Restore/bootstrap mode is represented explicitly in controller state.

### Safety

- [ ] Replaying bootstrap state does not generate fresh backend input from the reference web client.
- [ ] Temporary debug logging confirms the browser can distinguish user-originated and non-user-originated outbound traffic.

## Phase 2: Structured Browser Input And Source Tagging

### Common Browser Input

- [ ] Typing printable characters works.
- [ ] Pressing Enter works.
- [ ] Arrow-key navigation works.
- [ ] Backspace/Delete behavior still works in the validated shells/programs.
- [ ] Paste still works in the validated browser flow.
- [ ] Ctrl+C still works through the intended path.

### Source And Audit Semantics

- [ ] Human-originated browser input is logged/stamped as `human`.
- [ ] Emulator protocol is logged/stamped as `emulator_protocol`.
- [ ] Emulator protocol is not recorded as if the user typed those bytes.

## Phase 3: Terminal State Bootstrap

### Route Contract

- [ ] `GET /api/threads/:thread_id/terminal/state` returns owned state for an active thread session.
- [ ] The route returns `latest_byte_offset`.
- [ ] The route returns a safe bootstrap snapshot.
- [ ] Unauthorized or cross-user reads return `404`.

### Reference Web Open

- [ ] Opening an existing thread uses `terminal/state`.
- [ ] Opening an existing thread no longer replays raw `/terminal/history` into xterm as the normal bootstrap path.
- [ ] The initial terminal render is stable after open.

## Phase 4: Live-Only Stream And Durable Resume

### Stream Semantics

- [ ] Fresh terminal-stream attach without `after_offset` is live-only.
- [ ] Attach with `after_offset` replays only newer durable output.
- [ ] Reconnect after a short disconnect resumes from `last_rendered_byte_offset`.
- [ ] Session replacement or reset causes a clean refetch of `terminal/state`.

### Regression Checks

- [ ] The terminal still receives live output normally after the attach semantics change.
- [ ] `/terminal/history` still works as explicit history/scrollback access.
- [ ] The reference web client no longer depends on overlapping replay from both SSE buffering and `/terminal/history`.

## End-To-End Symptom Checks

- [ ] Returning to a thread no longer prints `1;2c`.
- [ ] Repeated tab/page switches no longer produce repeated `1;2c1;2c...` tails.
- [ ] Reconnect/open behavior remains stable when terminal output includes control traffic in history.

## Docs / Spec Alignment

- [ ] `docs/proto.md` updated.
- [ ] `service/src/routes/routes.spec.md` updated.
- [ ] `service/src/runtime/runtime.spec.md` updated.
- [ ] `service/src/terminal/terminal.spec.md` updated.
- [ ] `web/src/routes/$budId/budId.spec.md` updated.
- [ ] `web/src/routes/routes.spec.md` updated if needed.
- [ ] `web/src/lib/lib.spec.md` updated if needed.
- [ ] `bud/src/src.spec.md` updated if needed.
- [ ] `bud.spec.md` updated.

## Notes

- The first-pass bootstrap route may intentionally prioritize replay safety over perfect style fidelity.
- If IME, Alt/Meta, or browser-specific key paths remain on the raw fallback path, record that clearly rather than marking them as implicitly covered.

