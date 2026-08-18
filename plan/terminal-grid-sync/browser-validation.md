# Grid Renderer — Automated Browser Validation (2026-08-18)

Phase 2 was validated end-to-end with a scripted headless Chromium
(playwright-core + the machine's cached Playwright build) against the **real
stack**: dev Postgres, service (`pnpm dev`), web (vite), and a real daemon
(`grid-e2e` bud, fresh enrollment via a one-off `DEV_BUD_TOKEN_BYPASS`,
`BUD_BASE_DIR=/tmp/bud-e2e`). Auth: a session row minted directly in the dev
DB, cookie signed the way better-call does (HMAC-SHA256, **standard base64
with padding** — not base64url).

Harness: `<session scratchpad>/e2e/grid-e2e.mjs` (creates a fresh thread per
run, drives the thread page with `?renderer=grid`, asserts on pane DOM +
computed styles, screenshots each stage). Final result: **19/19 scenarios
pass**, including: prompt from full frame, typed echo roundtrip, ANSI-red and
256-color+bold styled runs, scrollback accumulation, nvim enter/edit/exit
with scrollback surviving the alt round trip, reload re-arm, a second
concurrent viewer + viewport resize, 30k-line and 5k-line floods, ctrl+c
interrupt, and byte-path default regression (no xterm in grid mode, no grid
pane in bytes mode, no unexpected console errors).

## Bugs found by the browser run (all fixed)

1. **Stale presence replay loop** (service): `terminal.bud_offline`/`bud_online`
   were buffered in the SSE event bus; every no-cursor attach replayed them,
   the client treated the stale `bud_online` as fresh and reconnected — an
   infinite loop for grid connections (which never resume by offset). Fix:
   presence events emit `buffer:false`, and grid connections attach live-only
   (`attachCallback(replay:false)`).
2. **Second concurrent viewer never seeded** (service): the watch armed only
   on the 0→1 viewer transition, so a viewer joining an already-watched
   session got deltas it had no baseline for and reconnect-looped. Fix: every
   viewer join re-arms the watch; the fresh full frame seeds the newcomer and
   is idempotent for existing viewers.
3. **Geometry never converged** (web): the pane's mount-time resize races
   session-record creation and 404s; the spec'd mismatch re-assert effect was
   missing, so sessions rendered at the DB spawn hint (200×50) with the live
   rows pinned above the fold (near-empty screens looked black). Fix: the
   pane re-asserts its measured size until the stream converges on it once.
4. **Multi-viewer geometry tug-of-war** (web, introduced by fix 3): two panes
   with different sizes re-asserted against each other forever. Fix:
   converge-once policy — stop asserting after the first match, re-arm on
   reconnect (covers daemon respawn at a stale hint). Semantics: last resize
   wins, same as the byte path. A real "smallest client wins" policy is
   future work if multi-viewer becomes first-class.

Environment note (not a grid bug): holders fail with
`path must be shorter than SUN_LEN` when the registry base dir is very long
(macOS 104-byte UDS path limit) — worth a friendlier ensure error someday.

## Phase 3 addendum (same day)

The harness now also validates predictive echo end-to-end with CDP-injected
300 ms network latency (23/23 total): the ghost tail renders locally before
the server echo, reconciles into the authoritative echo, the predicted
command executes, and the gate keeps ghosts off while a foreground command
runs. Two more cross-layer bugs found by the run, both of the same
"stripped at a boundary" family: the service zod schema dropped
`predict_ok`/`applied_input_seq` from grid frames, and the BudEnvelope typed
field-level encoding for `terminal_input` dropped `input_seq` (now field 4;
field 3 stays reserved for the retired 0.2 `await_ready`). One design
correction over the plan: readline/zle shells sit at the prompt in raw mode
with app-side echo, so the termios gate is an exclusion of silent-canonical
(`ICANON && !ECHO`) plus no-open-command — not a positive `ECHO && ICANON`
check, which would never open.

## What this run does NOT cover

Subjective rendering feel/perf on a physical display, IME composition, wide-
glyph cursor alignment across fonts, codex-style inline TUIs (needs auth), and
long-session soak. Those remain for human validation.
