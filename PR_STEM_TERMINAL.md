# PR: stem terminal stack — tmux replacement, grid-sync renderer, predictive echo

Branch `stem` → `main`. 35 commits, three tiers (daemon / service / web), one
storyline: replace the tmux-era terminal layer with the `stem` crate, move the
wire protocol to 0.3, and ship a server-authoritative grid renderer with
predictive local echo — now the web default.

## What this PR does

### 1. tmux → stem (native terminal session manager)

- New `stem` crate (`bud/stem/`): detached PTY **holder processes** with
  file-backed output rings, versioned UDS IPC, and a daemon-side
  `alacritty_terminal` emulator confinement. Sessions survive network
  disconnects AND daemon restarts.
- The tmux-era terminal layer is deleted (~4,300 LOC: `TerminalBackend`
  trait, readiness/delta/wait-strategy machinery, tmux doctor preflight →
  replaced by `--cleanup-tmux`).
- **Terminal facts replace readiness guessing**: OSC 133 shell integration
  yields exact command lifecycle (real exit codes); VT-emulator damage
  tracking yields TUI settling; sessions carry typed `mode`
  (`shell`/`tui`/`repl`/`unknown`) and `integration`
  (`osc133`/`sentinel`/`none`) facts — no confidence scores.
- Agent tool surface: `terminal.run` / `terminal.send` / `terminal.observe`
  (retired: `shell.run`, `terminal.exec`, `wait_for` mode selection).
- Wire protocol 0.3 (`docs/proto.md` §6 rewritten): service-owned session
  ULIDs, absolute byte offsets (idempotency key `(session_id, byte_offset)`),
  `terminal_event` typed facts, offset-resumable SSE.

### 2. Grid sync (`docs/proto.md` §6.8) — the renderer flip

The daemon-side emulator is authoritative; the browser draws exactly the
cells it is told (`plan/terminal-grid-sync/`):

- `terminal_grid` frames: styled runs (fg/bg palette-or-truecolor, 6-attr
  bitfield), full/delta frames with generation contiguity, scrollback pushes
  with drop accounting, event-driven emission (8 ms coalesce, 16 ms min gap).
- **Scroll-hint deltas** (§6.8.5): take-time row-identity diffing turns
  scroll repaints into `row_shift` + revealed-rows frames — measured 50
  shifts : 1 full at ~5× fewer bytes (WAN readiness).
- **Predictive local echo** (§6.8.3): client ghost tail with `input_seq` /
  `applied_input_seq` reconciliation; the daemon gates `predict_ok` on
  typed facts (interactive prompt ∧ ¬alt-screen ∧ termios not
  silent-canonical) — validated under 300 ms injected latency.
- **Input affordances**: SGR/X10 mouse reporting + wheel (alternate-scroll
  arrows, DECCKM-aware SS3 cursor keys), DECSCUSR cursor shapes (vim beam),
  IME composition via a hidden cursor-anchored textarea (CJK, dead keys,
  emoji-picker insertions), focus-dependent cursor (filled/blinking only
  when the pane owns the keyboard; hollow outline otherwise), strict
  input-POST serialization (fixes real HTTP reordering of fast typing).
- **Default flip**: `web/src/features/threads/terminal-renderer.ts` resolves
  to `grid`; xterm/bytes stays available via `?renderer=bytes` and the
  `localStorage` preference. The byte-stream path and storage are untouched.

## Validation

- **Rust**: full workspace green (stem 109 incl. grid parity harness +
  DECSCUSR/mouse/shift tests; daemon suite + stem integration tests);
  fmt + clippy clean.
- **Service**: 441 tests. **Web**: 119 tests, tsc, eslint, production build.
- **Browser E2E**: 36/36 scenarios against the real stack (headless Chromium
  driving dev service + daemon + Postgres): rendering fidelity, vim round
  trips, reload/resize/floods, predictive echo under latency, mouse/wheel
  into a raw-mode PTY reader, shift-delta bandwidth measurement, IME
  composition, cursor shapes, focus affordance. Harness:
  `plan/terminal-grid-sync/harness/grid-e2e.mjs`; findings + every bug the
  runs caught: `plan/terminal-grid-sync/browser-validation.md`.
- Live §A validation (real daemon + service + browser on macOS + Linux)
  recorded in `plan/native-terminal-session-manager/`.

## Deploy notes

- **DB migration**: `service/drizzle/migrations/0023_superb_alex_wilder.sql`
  (`terminal_command` table) — staging needs `pnpm db:migrate`.
- All three tiers ship together: the daemon is rewritten (tmux removed), the
  service speaks proto 0.3, the web defaults to grid. Older-daemon frames
  missing newer facts degrade gracefully (client defaults); the bytes
  renderer remains the escape hatch.
- Daemon holders are per-machine processes; existing tmux sessions are not
  migrated (`--cleanup-tmux` removes the old server).

## Known issues / deferred (documented in specs)

- bytes/xterm path has a latent CSI-only arrow bug under DECCKM (grid path
  fixed; noted in `browser-validation.md`).
- Wide-glyph cursor positioning assumes CJK glyphs render at exactly 2ch.
- Friendlier ensure error for `SUN_LEN` (very long holder base dirs).
- Cross-binary IPC version-skew CI job (no Rust CI lane yet); other
  SPEC:TODOs justified in plan records.

## Key docs

- `bud.spec.md` (root architecture) · `docs/proto.md` (wire contract, §6/§6.8)
- `plan/native-terminal-session-manager/` (stem migration plan + validation)
- `plan/terminal-grid-sync/` (grid-sync plan, phase records, browser validation, harness)
- `design/terminal-grid-sync-and-predictive-echo.md` (design doc)
