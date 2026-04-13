# Phase 7: Rich Bootstrap Contract And Capture Metadata

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Evolve `/api/threads/:thread_id/terminal/state` from a safe but text-only snapshot into an explicit richer bootstrap contract that can represent the current visible terminal screen with cursor, geometry, and screen-mode metadata.

This phase focuses on the daemon/service side of the problem. It should not yet assume the browser hydration mechanism.

## Scope

### Bootstrap Contract Upgrade

Extend `GET /api/threads/:thread_id/terminal/state` to return an explicit `bootstrap` union rather than only `snapshot: { text, source }`.

Recommended bootstrap modes:

- `grid`
- `text`
- `unavailable`

First implementation target:

- `grid` for tmux-backed visible-screen capture with cursor/geometry metadata
- `text` as an explicit degraded fallback when full fidelity is not available
- `unavailable` when Bud is offline or capture fails

### tmux Metadata And Visible-Screen Capture

Teach the daemon/service bootstrap path to gather:

- pane width and height
- cursor row and column
- cursor visibility/shape if available
- whether the pane is on the normal screen, alternate screen, or a tmux pane mode

The primary bootstrap capture should move away from:

- history-flavored `view: "history"`
- `capture-pane -J` joined text as the main payload

and toward:

- an exact visible-screen grid
- explicit degraded fallback when only text/history can be produced safely

### Compatibility Strategy

This phase may ship with a temporary compatibility window where `/terminal/state` returns both:

- legacy `snapshot`
- new `bootstrap`

if that materially lowers rollout risk.

If dual fields are used:

- `bootstrap` is the source of truth for new clients
- `snapshot` should be documented as compatibility-only
- the follow-up browser phase should remove active dependence on `snapshot`

## Deliverables

- Richer `/terminal/state` response contract with explicit bootstrap kinds
- Daemon/service helper support for cursor/geometry/screen-mode capture
- Updated protocol/spec docs for the richer bootstrap payload
- Clear degraded-fallback behavior rather than accidental text-only restore

## Expected Files

- `service/src/routes/threads.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/terminal/types.ts`
- `bud/src/main.rs`
- `docs/proto.md`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `bud/src/src.spec.md`
- `bud/bud.spec.md`

## Success Criteria

- [ ] `/terminal/state` exposes an explicit richer bootstrap payload.
- [ ] The richer payload distinguishes `grid`, `text`, and `unavailable` cases.
- [ ] `grid` bootstrap includes pane geometry.
- [ ] `grid` bootstrap includes cursor position.
- [ ] `grid` bootstrap includes enough mode metadata to distinguish normal screen from alternate-screen or pane-mode capture.
- [ ] The primary bootstrap payload is no longer derived from joined history text alone.
- [ ] A degraded `text` fallback remains possible without pretending it is cursor-accurate.
- [ ] Any compatibility `snapshot` field is explicitly documented as transitional.

## Risks And Notes

- The exact tmux command/format combination for "visible screen grid" still needs validation.
- Wrapped-row fidelity may require more than simply removing `-J`; this phase should validate rather than assume.
- It is acceptable to defer styling fidelity. Cursor, geometry, and row fidelity matter more.
- This phase should not reintroduce raw historical parser replay as a bootstrap mechanism.
- If alternate-screen or pane-mode capture is not ready on the first pass, return a degraded bootstrap kind explicitly rather than silently lying with shell-oriented text.

