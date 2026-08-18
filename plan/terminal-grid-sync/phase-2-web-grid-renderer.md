# Phase 2: web grid renderer (behind a flag)

## Context

- Contracts: [implementation-spec.md](./implementation-spec.md) §5–6, §8
- Specs to read first: `web/src/src.spec.md`, features/threads spec
- Depends on: phase 1 (live `terminal.grid` over SSE)

## Objective

A grid-state renderer that draws exactly what the server rendered — the
size-mismatch / reflow-race artifact class becomes impossible by
construction — switchable per user, with xterm.js remaining the default.

## Renderer decision (design open q.2 resolved)

**DOM rows, not canvas, for v1.** One `<div>` per row containing one `<span>`
per styled run; dirty-row patching replaces only changed row nodes. At
≤ 200×60 this is comfortably within budget, and it buys the two hard
problems for free:

- **Selection/copy**: native browser selection over real text nodes — no
  cell-math selection model, no clipboard plumbing.
- **Accessibility/find**: real text in the DOM.

Canvas/WebGL stays the later escape hatch if profiling ever demands it (the
grid-state model is renderer-agnostic; that's the point of the protocol).

## Changes (`web/src/`)

- `features/threads/terminal-grid-state.ts` — pure reducer:
  `applyGridFrame(state, frame)` maintaining `{generation, cols, rows,
  altScreen, cursor, rows: StyledRun[][], scrollback: StyledRun[][] (capped)}`;
  returns a discontinuity signal when `generation` skips (caller re-snapshots)
  and surfaces `scrollback_dropped`. Unit-testable without DOM.
- `features/threads/thread-terminal-grid-pane.tsx` — the renderer: row
  patching from reducer output, cursor overlay (block/visibility), scrollback
  list above the live grid, `ch`-grid monospace styling reusing the existing
  terminal theme; wide chars via per-run `width: Nch` from the run's computed
  cell count (server counts cells; include `w` per run **only if** measuring
  shows CSS `ch` mis-sizing wide glyphs — decide during implementation, keep
  the run object additive).
- `features/threads/use-terminal-session.ts` — renderer mode: `grid` connects
  with `?grid=1`, routes `terminal.grid` into the reducer, ignores
  `terminal.output` for rendering; keyboard/paste/input-queue/resize paths
  are shared verbatim (input handling does not change at all). Snapshot
  bootstrap: line-history from `/terminal/snapshot` seeds scrollback; first
  `full` frame seeds the live grid. On generation discontinuity or
  `bud_offline→online`: re-snapshot + expect `full` (same recovery shape as
  today's `output_gap`).
- Flag: `localStorage` `bud.terminal.renderer = "grid" | "bytes"` (default
  `bytes`), `?renderer=` URL override; a small toggle in the terminal pane
  header. Both implementations stay mounted-exclusive (switch = reconnect).

## Explicitly out of scope

Predictive echo (phase 3); removing xterm.js; mobile.

## Test plan

- Reducer unit tests: full→delta application, row replacement, scrollback
  append + cap, generation-skip signal, resize (full at new dims), cursor.
- Parity fixture test: replay a recorded frame sequence (captured from the
  phase-1 daemon integration test as JSON fixtures) through the reducer;
  assert final text grid matches the recorded `screen_lines`.
- Manual §A-style validation pass with the flag on: vim, htop, codex, flood,
  resize storm, reconnect drills — explicitly re-run the zsh PROMPT_SP `%`
  scenario and the reload-into-TUI scenario (both must be artifact-free by
  construction).

## Spec files to update

- [ ] `web/src/src.spec.md` + features/threads spec
- [ ] `plan/native-terminal-session-manager/validation-checklist.md` (grid-renderer §C addendum)

## Definition of done

Flag-on passes the manual validation pass; flag-off is byte-identical to
today; reducer + parity tests green.
