# Debug: cumulative `scrollback_push` in full grid frames (mobile report)

## Environment
- Report: `reference/terminal-grid-cumulative-scrollback-handoff.md`
  (physical iPhone vs production, 2026-08-27). Daemon/stem at v0.1.9/v0.1.10
  (grid code unchanged since the stem cutover #51).

## Repro / evidence (from the mobile capture)
- Same session, continuous generations 47→55, `full: true` frames.
- gen 51: `scrollback_push` = 979 rows (= post-grow history, 996−17);
  gen 55: 996 rows (= entire original history). Client scrollback
  996 → 1,975 → 2,971 with no corresponding terminal output; ~19K-pt
  content-height jumps around keyboard resizes.

## Investigation (all daemon-side, service forwards verbatim)

Instrumented three reproduction shapes against the real stack:

1. **Emulator-level resize** (unit): grow 22→39 pulls 17 lines from history
   (997→980, matching mobile's 996→979 arithmetic), shrink pushes back —
   `Emu::resize` re-anchors the scroll watermark correctly; **pushes: 0**.
2. **Saturated history (5000-line cap) + resize cycle** (e2e, real zsh):
   the identity-based scroll accounting behaves; **pushes: 0**.
3. **Resize storm racing live output** (e2e): pushes exact and incremental
   (802 total for 800 lines), dropped 0, generation monotonic. Clean.
4. **Watch enable after unwatched activity** (e2e): **REPRODUCED the bug
   class.** Seed 600 lines with no grid watch active → enable watch → the
   FIRST full frame carried `push=581` (whole seeded history); with 5300
   lines: `push=1024` (pending cap) + `dropped=4257`.

## Root cause

`GridTracker.observe_feed` accumulates scrollback pushes on **every** feed,
watch or no watch; only `take_grid_frame` drains them. Whenever no watch
loop is consuming (pre-watch lifetime of the attachment, viewer-count dark
windows between SSE disconnect/reconnect, watch churn), the backlog grows
(cap 1024). The next `terminal_grid_watch enabled` spawned a fresh loop
whose `force_full` first frame **shipped the entire backlog as an
"incremental" `scrollback_push`** — duplicating history the consumer had
already seeded from `/terminal/snapshot`. Generation continuity is
preserved throughout because the tracker (and its generation counter)
lives in the attachment, not the watch loop — matching the capture.

The consecutive `full: true` frames at unchanged geometry (report §5) are
watch re-arms: `handle_resize` emits a `ready` status, and the service
re-arms the watch on every `ready` while viewers exist; each re-arm
aborted and respawned the loop with a forced full frame.

Content of the bogus pushes: `recent_history_runs(n)` reads the LAST n
history lines, so an overcounted/backlogged push is precisely "the current
scrollback tail again" — exactly what mobile observed.

## Fix (daemon)

1. **Fresh watches start scrollback-clean**:
   `Session::reset_grid_scrollback_pending()` clears pending pushes + the
   dropped counter before a new watch loop spawns. A fresh consumer's
   snapshot covers all history up to now, so the clean slate is the correct
   baseline (the snapshot→watch race window is accepted per the mobile
   contract; rows produced inside it arrive via the pump before the reset
   only if a previous loop existed — in the fresh case they are covered by
   the snapshot's `ring_next_offset` pairing).
2. **Re-arms are in-place**: `terminal_grid_watch enabled` on a LIVE loop no
   longer aborts/respawns; it sets a `grid_force_full` flag the loop
   consumes on its next take. Pending pushes survive re-arms — they are
   real deltas for already-connected consumers (web mid-session) — and
   generation/full semantics are unchanged.

Not changed: mid-watch pending-cap overflow still reports
`scrollback_dropped` (honest seam); the service's re-arm-on-ready behavior
(now harmless); the client contract (`scrollback_push` stays strictly
incremental — no new fields).

## Residual uncertainty

The capture's fine structure (pushes on gen 51/55 rather than the first
frame at 47) implies viewer churn mid-session (SSE reconnects around
keyboard transitions toggling the watch off/on while generations continue)
— consistent with this mechanism, but not reproducible byte-for-byte from
the log alone. If a device capture still shows cumulative pushes after
this fix deploys, next step is daemon-side logging of per-feed
`scrolled_lines` and watch enable/disable transitions for the session.

## Regression coverage
- e2e: watch-after-seeded-history first full frame has `push=0, dropped=0`;
  resize cycle (22→39→22) pushes 0; input pushes only genuinely scrolled
  rows; re-arm preserves in-flight pushes and stays generation-continuous.
