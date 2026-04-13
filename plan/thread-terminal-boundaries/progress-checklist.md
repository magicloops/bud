# Thread Terminal Boundaries Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not started
- `[~]` in progress
- `[x]` completed
- `[-]` deferred or intentionally out of scope

## Phase 1: Browser Transport Boundary

- [ ] Add browser-side terminal transport/controller module.
- [ ] Add isolated xterm adapter that recovers `wasUserInput`.
- [ ] Move outbound terminal wiring out of `web/src/routes/$budId/$threadId.tsx`.
- [ ] Add explicit `human` vs `emulator_protocol` classification in the controller.
- [ ] Add temporary debug logging/assertions for outbound classification.

## Phase 2: Structured Browser Input And Source Tagging

- [ ] Add `POST /api/threads/:thread_id/terminal/send`.
- [ ] Reuse the existing structured Bud/runtime send path behind the new route.
- [ ] Move normal browser typing/special-key interaction onto the structured route.
- [ ] Keep a narrow raw-bytes fallback for unsupported cases.
- [ ] Propagate explicit source taxonomy through touched service/runtime/daemon paths.
- [ ] Stop treating emulator protocol as human input in logs/runtime writes.

## Phase 3: Terminal State Bootstrap

- [ ] Add `GET /api/threads/:thread_id/terminal/state`.
- [ ] Return `latest_byte_offset` plus safe bootstrap snapshot.
- [ ] Update reference web open flow to use `terminal/state`.
- [ ] Update reference web reconnect/bootstrap flow to stop using `/terminal/history` as the normal redraw path.

## Phase 4: Live-Only Stream And Durable Resume

- [ ] Add `after_offset` support to terminal stream attach.
- [ ] Make no-cursor terminal-stream attach live-only.
- [ ] Implement durable catch-up for terminal output after an offset.
- [ ] Track `last_rendered_byte_offset` in the reference web client.
- [ ] Reclassify `/terminal/history` as explicit scrollback/history only.

## Phase 5: Validation, Docs, And Cleanup

- [ ] Add/update focused tests for source classification and stream semantics.
- [ ] Update `docs/proto.md`.
- [ ] Update touched web/service/bud specs.
- [ ] Update `bud.spec.md`.
- [ ] Run the manual validation checklist.
- [ ] Minimize and document any retained compatibility/fallback paths.

## Phase 6: Optional Observation Send Adoption

- [ ] Add optional `observe` support to the shared `terminal_send` contract.
- [ ] Make dispatch-only send the default for normal browser xterm interaction.
- [ ] Update the browser controller so typing no longer waits on observed-send latency.
- [ ] Expose explicit observation controls through the agent-facing terminal send path.
- [ ] Document the intended default observation behavior for browser vs agent callers.
- [ ] Validate that observed and unobserved sends still preserve source/audit semantics.

## Phase 7: Rich Bootstrap Contract And Capture Metadata

- [x] Evolve `/terminal/state` from `snapshot` toward an explicit richer `bootstrap` union.
- [x] Add `grid`, `text`, and `unavailable` bootstrap modes.
- [x] Capture pane geometry and cursor position for richer bootstrap.
- [x] Capture enough tmux mode metadata to distinguish normal screen from alternate screen or pane mode.
- [x] Stop treating joined history text as the long-term primary bootstrap payload.
- [x] Document any temporary compatibility fields or degraded fallback behavior.

## Phase 8: Browser Rich Bootstrap Adoption And Cursor Fidelity

- [x] Update the reference web client to consume richer `bootstrap` kinds.
- [x] Add cursor-aware `grid` hydration in the terminal controller.
- [x] Preserve blank rows for richer `grid` bootstrap.
- [x] Add an explicit geometry mismatch policy for richer bootstrap.
- [x] Remove or scope the temporary trailing-blank-line trim workaround.
- [ ] Validate fresh-page reopen behavior for shell and TUI sessions.
