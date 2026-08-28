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

## Second root cause (2026-08-28, found via the v0.1.11 device retest)

Mobile re-tested on v0.1.11 (upgrade log confirmed the fixed daemon) and
reproduced again: gen=20, full=true, push=998, previous=980 — this time
with a TUI open, right after the UPGRADE ITSELF restarted the daemon, and
triggered by keystrokes from mobile.

Reproduced locally (`restart_reattach_mid_tui_never_pushes_replayed_history`):
daemon restart with an alt-screen TUI open → sessions reattach → the ring
replay arrives as one large chunk that ENDS inside the alt screen. The
scroll-accounting block in `Emu::feed` only runs when a feed ends on the
PRIMARY screen, so the fresh emulator's watermark stayed at 0 even though
the replay built the full primary history. The first live alt-exit then
computed `history_size − 0` = the ENTIRE replayed history as freshly
scrolled — pre-fix: `push=588` for 588 seeded rows, matching the device's
998. (Multi-chunk replays that end primary anchored correctly, which is
why ordinary sessions never showed it.)

Fix: `Emu::sync_scroll_anchor()` runs after every attach replay — anchors
immediately when the replay ends primary, or defers via
`anchor_pending_alt_exit` when it ends in alt: the first primary feed then
anchors with `scrolled_lines = 0` and no seam, because everything up to
that point predates the attachment and is covered by consumers'
snapshots. Post-exit incremental pushes verified healthy in the same
regression.

## Regression coverage
- e2e: watch-after-seeded-history first full frame has `push=0, dropped=0`;
  resize cycle (22→39→22) pushes 0; input pushes only genuinely scrolled
  rows; re-arm preserves in-flight pushes and stays generation-continuous.

## Third report (2026-08-28, v0.1.12): input-path full with push=998

Mobile reproduced on a confirmed v0.1.12 daemon
(`reference/terminal-grid-v0.1.12-input-scrollback-regression-handoff.md`):
clean attach + geometry fulls (gens 1–5, 48×38→48×20, `alt_screen=false`
throughout), then two printable one-byte inputs → gen 6 `full=true`,
`scrollback_push=998` (`previous=980`, dropped 0, row_shift 0), then
`applied_input_seq` acks at gens 7–8.

Static analysis of the capture:
- gen 6 was almost certainly the §6.8.3 predict-gate forced full: the
  watch refreshes termios on its first tick after input, and a gate flip
  takes `take_grid_frame(true)` outside the damage path — explaining
  `full=true` at input time (the local pure-input repro emits deltas). A
  take only DRAINS the tracker, so the 998 rows were already pending: some
  tracked live feed reported `scrolled_lines≈998`.
- `scroll_history_lost` only bumps `dropped` (never pushes), the identity
  path needs `hist == cap` (5000), `Emu::resize` re-anchors on the primary
  screen, and every primary-ending feed self-anchors the watermark — so a
  stale-anchor story contradicts the all-primary frames. The only
  mechanism consistent with every number (980 snapshot + exactly the 18
  rows the 38→20 shrink reflowed into history) is the first tracked live
  feed RE-PARSING ring bytes the attach replay had already fed: a
  re-parse duplicates emulator history row-for-row and ships the
  scrollback tail as an "incremental" push — exactly what mobile renders.
  The live loop fed holder pushes at face value, with no cursor check.
- The clean local repro (restart → reattach at a primary prompt → resize
  convergence + ready re-arms → printable input) stays push=0; the
  production delivery quirk itself was not reproduced.

Fix + forensics (branch `fix/terminal-grid-live-feed-guard`):
1. **Duplicate-delivery guard** (`stem/src/session.rs`): the live loop
   tracks `live_cursor` (starting at the replay end); pushes entirely
   below it are dropped, partial overlaps clipped to the unparsed tail
   (`clip_before_cursor`, unit-tested). Double-parse is structurally
   impossible per attachment regardless of holder delivery behavior — and
   each clip/drop warn-logs (the smoking gun if it ever fires).
2. **Forensic instrumentation** (mobile doc items 1–8): attach-replay
   completion logs offsets + `ScrollDebug` anchor state; any tracked feed
   with `scrolled_lines ≥ 300` warn-logs before/after anchor state;
   `terminal_ensure` logs `resume_from_offset` + post-attach `GridDebug`;
   fresh grid-watch enable logs the cleared pending baseline; every frame
   logs provenance (`watch_start`/`rearm`/`gate_flip`/`damage`) at debug,
   and any frame shipping ≥ 300 pushed rows warn-logs full grid state.
3. Regression `restart_reattach_primary_input_stays_scrollback_clean`
   (`bud/tests/terminal_stem.rs`): the report's primary-input acceptance
   shape — every frame across attach, resize convergence, ready re-arms,
   and printable input must carry `push=0, dropped=0, alt=false`.

## Fourth report (2026-08-28, v0.1.13): resize-correlated bursts — NOT a daemon bug

Mobile re-tested with the live-feed guard deployed
(`reference/terminal-grid-resize-rearm-regression-handoff.md`): input is
now clean, but every keyboard-driven resize is followed (after 1–2 clean
convergence fulls) by a replay-sized push — 980 rows at 48×38, 998 at
48×20, alternating across four cycles on one continuous gen-103–121
attachment.

Resolution: **the wire data is correct.** The arithmetic is decisive —
`push + rows = 1018` at both geometries — each burst is the foreground
program clearing and reprinting its full ~1018-line transcript on
SIGWINCH at the current height. Reproduced exactly with a WINCH-trap
reprint script driven through the production lifecycle (bursts per cycle
sum to 1018, dropped=0, delayed after convergence, generations
continuous); a plain-prompt foreground stays at push=0 through identical
cycles (standing regressions). Inline-TUI agent CLIs (codex/claude-code)
redraw this way in desktop terminals too — resizing a terminal running
them duplicates scrollback there as well.

Also explains earlier report anomalies: report #3's input-burst was
998 = 1018−20 at 48×20 — likely the same reprint triggered by input to
the then-running TUI rather than a delivery duplication (the guard
remains correct defense-in-depth either way; the v0.1.13 forensics'
"large scroll burst" warns show `history_size` genuinely growing for
reprints, which distinguishes the two on any future capture).

Recommendation recorded in the handoff response: mobile should stop
resizing the PTY on keyboard show/hide (fixed rows + view cropping) —
every PTY resize SIGWINCHes the foreground program. Daemon-side
suppression is impossible without corrupting legitimate large outputs.
