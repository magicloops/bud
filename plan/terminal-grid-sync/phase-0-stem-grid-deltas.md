# Phase 0: stem grid-delta substrate

## Context

- Design: [design/terminal-grid-sync-and-predictive-echo.md](../../design/terminal-grid-sync-and-predictive-echo.md) §3.1
- Contracts: [implementation-spec.md](./implementation-spec.md) §2–3
- Specs to read first: [bud/stem/stem.spec.md](../../bud/stem/stem.spec.md)

## Objective

stem can answer "what changed on screen since I last asked, as styled cells" —
`Session::take_grid_frame()` returning the `GridFrame` of implementation-spec
§3. Pure library work: no wire, no daemon changes, fully unit-testable.

## Changes

### `emu.rs` — styled-row export

- New stem-owned types (alacritty types stay confined to this module):
  `CellColor { Named(u8), Indexed(u8), Rgb(u8,u8,u8) }`, `CellAttrs`
  (bitflags matching the §2 bitfield), `StyledRun { text, fg: Option<CellColor>,
  bg: Option<CellColor>, attrs: CellAttrs }`.
- `row_runs(row: u16) -> Vec<StyledRun>` — run-length grouping by
  presentation, identical segmentation to `SgrState::apply` (extract the
  per-cell style comparison into a shared helper so `screen_ansi` and
  `row_runs` cannot drift). Wide-char spacers skipped, zero-width kept,
  trailing default-styled blanks trimmed — the exact `screen_ansi` row shape.
- `history_row_runs(index_from_recent: usize) -> Vec<StyledRun>` — styled
  variant of the negative-Line access `scrollback_lines` uses.

### `session.rs` — damage accumulation + frame assembly

- New `GridTracker` state on the session: dirty-row set, `full_pending` flag,
  pending `scrollback_push` buffer (cap 1024 lines, overflow counts into
  `scrollback_dropped`), `generation` counter.
- Fed from the existing per-feed processing path: `damaged_rows` → dirty set;
  `full_repaint` / resize / alt-screen toggle → `full_pending`;
  `scrolled_lines > 0` → immediately capture those lines via
  `history_row_runs` (before later feeds can evict them).
- `take_grid_frame(&mut self, force_full: bool) -> Option<GridFrame>`:
  assembles the frame from current grid state + drained tracker, bumps
  `generation`, resets the tracker. `None` when clean and not forced.
- Replay interaction: attach replay feeds the emulator as today; the tracker
  starts *after* replay (first frame a consumer sees is `full`), consistent
  with replay's state-faithful/event-suppressed contract.

## Explicitly out of scope

Termios facts / holder IPC (phase 3 — the only phase that needs them), any
daemon or wire change, cadence policy (daemon-owned, phase 1).

## Test plan (stem unit + integration)

- Run segmentation: colors/attrs/truecolor grouping; wide + zero-width chars;
  trailing-blank trim — cross-checked against `screen_ansi` on the same grid
  (feed `screen_ansi` output to a fresh emu, compare `row_runs` per row).
- Accumulation: N feeds touching one row → one dirty row; scroll → `full`;
  resize → `full` at new dims; clean take → `None`; generation monotonic.
- Scrollback capture: scroll K lines between takes → K pushes oldest-first;
  overflow past 1024 sets `scrollback_dropped`; alt-screen flood → zero pushes.
- Parity harness (the drift regression net): feed bake-off fixture corpus in
  random-size chunks, `take_grid_frame` at random points, apply frames in a
  tiny test-side reducer, assert reduced grid text == `screen_lines()` after
  every take.

## Spec files to update

- [ ] `bud/stem/stem.spec.md` (emu/session entries, status)

## Definition of done

`cargo test -p stem` green incl. the parity harness; clippy/fmt clean; spec
updated; no public-API breakage for existing daemon callers.
