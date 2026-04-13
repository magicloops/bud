# Phase 8: Browser Rich Bootstrap Adoption And Cursor Fidelity

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Adopt the richer terminal bootstrap contract in the reference web thread view so shell and TUI reopen behavior preserves cursor placement and visible-screen layout more faithfully, especially on fresh page loads.

This phase focuses on browser hydration, geometry handling, and cleanup of the temporary shell-oriented cursor workaround.

## Scope

### Browser Bootstrap Adoption

Update the thread route and terminal controller to consume `bootstrap` instead of relying on the older text-only `snapshot`.

Expected behavior:

- `bootstrap.kind: "grid"` becomes the primary restore path
- `bootstrap.kind: "text"` remains a best-effort degraded fallback
- `bootstrap.kind: "unavailable"` produces an honest empty/offline bootstrap state

### Grid Hydration

Implement a browser hydration path for `grid` bootstrap that:

- renders exactly one visible row per captured row
- preserves blank rows
- restores cursor position explicitly
- keeps bootstrap replay-safe

Preferred first-path implementation:

- generate a small, controlled render sequence through xterm's public write path

Fallback browser option:

- direct xterm buffer mutation only if the public-render path proves insufficient

### Geometry Mismatch Handling

Add an explicit browser policy for capture-geometry mismatch.

The first pass should define what happens when:

- capture pane size differs from current xterm size
- the pane is on the alternate screen
- the pane is in tmux pane mode

Recommended default:

- allow degraded best-effort render for `text`
- prefer resize-then-refetch or other explicit handling for `grid` captures where mismatch would materially break TUI fidelity

### Cleanup Of Temporary Cursor Workaround

The temporary blank-line trimming experiment in `thread-terminal-controller.ts` should be:

- removed for `grid` bootstrap
- kept only for explicit degraded `text` fallback if still needed
- deleted entirely if the richer bootstrap path makes it unnecessary

## Deliverables

- Reference web support for richer `bootstrap` kinds
- Cursor-aware browser hydration for `grid`
- Explicit geometry mismatch handling
- Removal or strict scoping of the temporary blank-line trim workaround
- Validation notes/spec updates describing the new browser bootstrap behavior

## Expected Files

- `web/src/routes/$budId/$threadId.tsx`
- `web/src/lib/thread-terminal-controller.ts`
- `web/src/lib/api.ts`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/lib/lib.spec.md`
- `docs/proto.md`
- `plan/thread-terminal-boundaries/validation-checklist.md`

## Success Criteria

- [ ] The reference web client consumes the new `bootstrap` contract.
- [ ] `grid` bootstrap restores the cursor to the intended row/column on reopen.
- [ ] `grid` bootstrap preserves blank rows instead of collapsing them.
- [ ] The current temporary trailing-blank-line trim is not applied to `grid` bootstrap.
- [ ] `text` bootstrap remains clearly degraded rather than pretending to be cursor-accurate.
- [ ] Opening the same thread on a new page no longer places the cursor incorrectly for validated shell/TUI cases.
- [ ] Geometry mismatch behavior is explicit and documented.

## Risks And Notes

- Browser hydration may still need iteration even after the richer contract lands; keep the render path isolated in the terminal controller.
- Multi-view geometry ownership remains a product/architecture concern; this phase should choose an explicit first-pass policy rather than solving all collaboration cases.
- The browser should not merge optional history/context content into the xterm hydration payload.
- If a TUI restore still cannot be made faithful under certain capture scopes, degrade explicitly instead of silently rendering a misleading shell-like snapshot.

