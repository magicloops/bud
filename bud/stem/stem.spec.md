# stem.spec.md

`stem` is Bud's native terminal session manager — the tmux replacement. Library crate
(workspace member of `bud/`), shipped inside the `bud` binary; the holder process is
`bud term-hold` (hidden subcommand re-exec, single-binary install).

Authority: [design/native-terminal-session-manager.md](../../design/native-terminal-session-manager.md)
(D1–D15); owning plan phase: [plan/native-terminal-session-manager/phase-1-stem-crate.md](../../plan/native-terminal-session-manager/phase-1-stem-crate.md).

## Architecture

**Dumb holder, smart client.** A detached per-session holder process (double-fork +
`setsid`; survival matrix passed on macOS launchd and Linux systemd with
`KillMode=process` — `spikes/holder-survival/findings.md`) owns one PTY, one capped
file-backed ring of raw output, and a UDS server speaking a closed, versioned,
additive-only protocol. All intelligence (VT emulation, OSC 133/OSC 7/alt-screen
scanning, mode classification, key encoding) runs client-side in the daemon and
upgrades with every release.

## Files (`src/`)

| File | Runs in | Purpose |
|---|---|---|
| `lib.rs` | — | Module tree, crate docs, re-exports (`Session`, `Event`, `StemError`) |
| `error.rs` | both | `StemError` (typed `SessionGone` / `VersionMismatch` for daemon branching) |
| `ipc.rs` | both | **Frozen wire contract** (`PROTO_VERSION` = 2, `ClientMsg`/`HolderMsg`, length-prefixed postcard framing, sync + async codecs). Additive-only evolution; v2 appends `QueryTermios`/`TermiosAck` (clients MUST version-gate: v1 holders close the connection on unknown variants) |
| `events.rs` | daemon | Typed `Event`/`Mode`/`Integration` — facts mapped by the daemon onto proto `0.3` `terminal_event` (docs/proto.md §6.7.3). Command ids are session-local `u64`; daemon mints ULIDs |
| `pty.rs` | holder | `nix` openpty + fork/exec (D4 amended: spike-proven raw-fd mechanics; portable-pty reserved for future ConPTY), TIOCSWINSZ resize |
| `ring.rs` | holder | Capped file-backed ring, absolute offsets forever, truncation-reporting range reads |
| `holder.rs` | holder | Daemonization + PTY pump ⇄ ring ⇄ IPC server; blocking std + threads (no tokio pre-fork); post-exit TTL |
| `registry.rs` | daemon | `<base>/<session_id>/` discovery, holder spawn via re-exec launcher, stale GC, session-id path-safety |
| `client.rs` | daemon | Async `HolderClient` (control ops) + `subscribe()` push channel (`HolderPush`); request/reply is cancel-owed-aware (owed replies from cancelled request futures are drained before the next write — orphaned acks were misattributed to the next caller, live ARM `expected Ok, got TermiosAck`) |
| `emu.rs` | daemon | `alacritty_terminal` 0.26 confinement (D5): grid/scrollback/cursor/alt-screen, cursor-filtered `meaningful_damage`, `KeyModes`, styled-run export (`StyledRun`/`CellColor`, `row_runs`/`recent_history_runs`), `MouseModes`/`mouse_modes()` DECSET facts, `cursor_shape()` DECSCUSR (vi-mode aware; default = blinking block, `reset_cursor_style()` clears app residue at prompt return), tab cells exported as single spaces (`display_char` — clients must not re-expand `\t`) with `screen_ansi()` serialized FROM the same runs (no drift possible; roundtrip-tested), exact scroll-push accounting via top-row identity tracking (correct even at history-cap saturation, honest `scroll_history_lost` otherwise) |
| `semantic.rs` | daemon | Chunk-boundary-safe raw-stream scanner: OSC 133 A/B/C/D+exit, OSC 7 cwd, alt-screen DECSET/DECRST — emulator-agnostic (D6a) |
| `modes.rs` | daemon | `ModeMachine` (Shell/Tui/Repl/Unknown, D7) with injected `ReplMatcher` (REPL prompt policy stays in the daemon) |
| `keys.rs` | daemon | Backend-neutral key names → mode-aware escape sequences; bracketed-paste text encoding (D9) |
| `session.rs` | daemon | Public `Session`: attach = connect → ring replay through fresh emu/scanner → subscribe; composes everything into `Event`s incl. DamageQuiet `Settled`. After replay, `Emu::sync_scroll_anchor()` re-anchors scroll accounting (deferred to the first primary feed via `anchor_pending_alt_exit` when replay ends inside the alt screen) so replayed history is never counted as freshly scrolled — the restart-mid-TUI cumulative-scrollback fix. Input is activity: programmatic writes (`write_text`/`paste_text`/`send_key`, not raw human `write_raw`) arm the quiet timer (`input_pending` + a `Notify` wake) so a gesture the program ignores, or one typed at an idle shell prompt, still yields a `Settled` at the next quiet point; `is_quiet()` exposes the current quiet state for awaited observes. Grid-sync substrate: `GridTracker` accumulates dirty rows/scrollback pushes per feed; `take_grid_frame()` drains them into a `GridFrame` (pull API — caller owns cadence; first frame full; cursor-only and input-mode-only frames — mouse/DECCKM toggles are frame-worthy; scroll-hint deltas: take-time row-identity (addr + content hash) shift detection turns scroll-forced full repaints into `row_shift` + revealed-rows frames, degrading to true fulls on any ambiguity; capped pending pushes with counted drops; `reset_grid_scrollback_pending()` clears the pending backlog for fresh watches — see the daemon watch semantics). Parity harness: fixture corpus → frames → reducer == `screen_lines()` |
| `introspect.rs` | daemon | cwd/foreground-process fallback (libproc / procfs); OSC 7 preferred |

`tests/` — integration suites plus `tests/fixtures/` (corpus copied from
`spikes/emulator-bakeoff/fixtures/`).

`README.md` — standalone-package framing: embedder quickstart and
responsibilities, semantic edge cases, and the extraction roadmap
(crates.io naming, holder-binary distribution, skew CI, API polish,
shim helpers, platform matrix, IPC semver policy, fuzzing).

## Contracts

- `stem` never imports `bud` (dependency direction enforced by Cargo).
- `ipc.rs` is the upgrade-skew surface: holders outlive daemon upgrades; additive
  changes only, version bumps per design D3d (client accepts holder ≤ its version).
- Ring/meta/socket layout under the session dir is holder-private except
  `holder.sock` + `meta.json` (read by `registry.rs`).
- alacritty API usage confined to `emu.rs`; scanner independent of the emulator.

## Status

Phase 1 complete (2026-08-15): all modules implemented and tested — 70 unit tests,
integration suites for the process layer (real in-process holders), stream layer
(bake-off fixture corpus incl. every-split-point scanner tests), session layer
(OSC 133 lifecycle with real `/bin/sh`, reattach backfill/suppression, unknown-mode
settling), plus the true single-binary re-exec test (`bud/tests/term_hold.rs`:
daemonized `bud term-hold` spawn/reuse/kill through `Registry`). `examples/repl.rs`
is the manual smoke tool. clippy/fmt clean.

Grid-sync Phase 3 additions (2026-08-18): IPC v2 `QueryTermios` (tcgetattr on the
PTY master; ECHO/ICANON facts for the predictive-echo gate), version-gated
`HolderClient::query_termios` / `Session::query_termios` (`None` for surviving v1
holders), real-PTY toggle test (`stty -echo`) plus the v1 skip test.

Grid-sync Phase 0 complete (2026-08-18,
[plan/terminal-grid-sync/phase-0-stem-grid-deltas.md](../../plan/terminal-grid-sync/phase-0-stem-grid-deltas.md)):
styled-run export, exact scroll accounting, `Session::take_grid_frame` — 8 grid
unit tests incl. the corpus parity harness.

<!-- SPEC:TODO -->
- IPC version-skew CI job (holder built at previous tag vs HEAD client) awaits a CI
  lane for the Rust workspace — `.github/workflows/` currently only builds releases.
  In-process version-mismatch handshake tests exist in `client.rs`; the cross-binary
  variant is deferred to CI setup (tracked for Phase 2 exit).
- `Resized` events are emitted only as echoes of client-initiated resizes; holder-side
  observation (e.g. another client resizing) is not pushed — needs an additive IPC
  push if multi-client resize ever matters.

---

*Referenced by: [../bud.spec.md](../bud.spec.md), [../src/src.spec.md](../src/src.spec.md)*
