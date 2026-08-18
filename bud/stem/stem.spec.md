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
| `ipc.rs` | both | **Frozen wire contract** (`PROTO_VERSION`, `ClientMsg`/`HolderMsg`, length-prefixed postcard framing, sync + async codecs). Additive-only evolution |
| `events.rs` | daemon | Typed `Event`/`Mode`/`Integration` — facts mapped by the daemon onto proto `0.3` `terminal_event` (docs/proto.md §6.7.3). Command ids are session-local `u64`; daemon mints ULIDs |
| `pty.rs` | holder | `nix` openpty + fork/exec (D4 amended: spike-proven raw-fd mechanics; portable-pty reserved for future ConPTY), TIOCSWINSZ resize |
| `ring.rs` | holder | Capped file-backed ring, absolute offsets forever, truncation-reporting range reads |
| `holder.rs` | holder | Daemonization + PTY pump ⇄ ring ⇄ IPC server; blocking std + threads (no tokio pre-fork); post-exit TTL |
| `registry.rs` | daemon | `<base>/<session_id>/` discovery, holder spawn via re-exec launcher, stale GC, session-id path-safety |
| `client.rs` | daemon | Async `HolderClient` (control ops) + `subscribe()` push channel (`HolderPush`) |
| `emu.rs` | daemon | `alacritty_terminal` 0.26 confinement (D5): grid/scrollback/cursor/alt-screen, cursor-filtered `meaningful_damage`, `KeyModes`, `screen_ansi()` (SGR-run + cursor serialization for snapshot fidelity, roundtrip-tested) |
| `semantic.rs` | daemon | Chunk-boundary-safe raw-stream scanner: OSC 133 A/B/C/D+exit, OSC 7 cwd, alt-screen DECSET/DECRST — emulator-agnostic (D6a) |
| `modes.rs` | daemon | `ModeMachine` (Shell/Tui/Repl/Unknown, D7) with injected `ReplMatcher` (REPL prompt policy stays in the daemon) |
| `keys.rs` | daemon | Backend-neutral key names → mode-aware escape sequences; bracketed-paste text encoding (D9) |
| `session.rs` | daemon | Public `Session`: attach = connect → ring replay through fresh emu/scanner → subscribe; composes everything into `Event`s incl. DamageQuiet `Settled` |
| `introspect.rs` | daemon | cwd/foreground-process fallback (libproc / procfs); OSC 7 preferred |

`tests/` — integration suites plus `tests/fixtures/` (corpus copied from
`spikes/emulator-bakeoff/fixtures/`).

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
