# Phase 1: The `stem` Crate

Design refs: D1 (packaging), D3 (holder/IPC/registry), D4 (PTY), D5 (emulator), D6a (OSC 133 scanner), D7 (mode machine), D8 (ring/output), D9 (input), D10 (native API), D11 (introspection), D12 (platforms).

## Objective

A library crate at `bud/stem/` that manages persistent PTY sessions with semantic events, **fully tested without the daemon**. The daemon is untouched in this phase (except the workspace conversion and the hidden `term-hold` subcommand forwarding). Merges to `main` as inert code.

## Prerequisites

Phase 0 go; emulator decision made; supervision recipe known (holder must implement the exact detach mechanics the spike validated).

## Work items

### 1.1 Workspace conversion

- `bud/Cargo.toml` gains `[workspace] members = ["stem"]`; the `bud` root package stays in place (no `src/` moves).
- `stem` crate: no dependencies on `bud` types (enforced by direction of `Cargo.toml` deps only — `bud` depends on `stem`, never the reverse).
- `bud` bin: hidden `term-hold` subcommand forwarding argv to `stem::holder::run()` (clap `hide = true`).

### 1.2 Module layout (proposed; becomes `bud/stem/stem.spec.md` structure)

| Module | Contents | Runs in |
|---|---|---|
| `holder` | main loop: PTY pump ⇄ ring ⇄ IPC server; detach mechanics from spike recipe; self-TTL after child exit (design open q. 3, default 24h) | holder |
| `pty` | `portable-pty` wrapper: spawn with cwd/env/size, resize, kill, child pid | holder |
| `ring` | capped file-backed ring (`ring.log`, default 8 MiB — design open q. 1), absolute byte offsets from session start, wrap-safe range reads | holder |
| `ipc` | framed UDS protocol: `Hello{proto_version}`, `Write`, `Resize`, `Subscribe{from_offset}` → push `Output{offset,bytes}`/`ChildExited{status}`, `RingSnapshot`, `Stat`, `Kill`, `Shutdown`; postcard/bincode; additive-only versioning | both |
| `registry` | `~/.bud/term/<session_id>/{holder.sock, meta.json}`; create/discover/GC-stale (dead pid); dir mode 0700 | daemon side |
| `client` | `Session` handle: `create/attach → { write, resize, kill, events(), screen(), ring_read(range), stat() }` | daemon side |
| `emu` | emulator wrapper (Phase 0 winner): grid, damage regions, scrollback, alt-screen flag, cursor; ring-replay on attach + SIGWINCH repaint nudge | daemon side |
| `semantic` | pre-emulator stream scanner: OSC 133 A/B/C/D (+ exit code), OSC 7 cwd, alt-screen enter/exit; mode state machine `Shell(AtPrompt|Running) / Tui / Repl / Unknown` with pluggable REPL matcher (policy injected by caller — the registry itself is daemon-owned, D7) | daemon side |
| `events` | `Event = Output | ModeChanged | PromptStart | CommandStart | CommandEnd{exit} | DamageQuiet | ChildExited | Resized` | daemon side |
| `keys` | semantic key → escape sequence table, mode-aware (DECCKM, keypad), bracketed-paste wrapping for multi-line literal text | daemon side |
| `introspect` | cwd/foreground-process: `/proc` (Linux), `libproc` (macOS), `tcgetpgrp`; OSC 7 preferred when present | daemon side |

### 1.3 Behavioral requirements (from design)

- Holder never parses terminal content — bytes in, bytes out (dumb-holder principle; the ~8-op command set is **closed**, changes require design-doc amendment).
- `Subscribe{from_offset}` earlier than ring head returns `TruncatedFrom{oldest_offset}` then streams — the client learns a gap exists rather than silently missing bytes.
- Attach = connect + `Hello` version check + `Stat` + ring-replay through fresh `emu` + subscribe from replay end. Reattach after holder death = registry GC + typed `SessionGone` error.
- `DamageQuiet` is an emitted event (timer armed on damage, reset on damage), not a poll: the daemon must never sample.

## Test plan

- **Unit:** ring wrap/range/truncation-reporting; IPC round-trip + version-mismatch handshake; OSC 133 scanner against Phase 0 fixtures (including markers split across read boundaries); key table vs mode flags; mode-machine transition table.
- **Integration (real PTYs, no daemon):** scripted `sh` session with a hand-rolled PROMPT_COMMAND emitting OSC 133 → assert `CommandEnd{exit}` for exit 0/1/130; vim fixture → `Tui` mode + `DamageQuiet` after quiet; kill client, write output, reattach → replayed grid matches and subscribe resumes without loss; holder outlives client process exit (in-CI approximation: client kill −9, not full launchd).
- **Skew (CI job):** holder built from the previous git tag, client from HEAD, `Hello` + subscribe round-trip passes.
- Platform CI: macOS + Linux runners for the integration suite.

## Exit criteria

- `cargo test -p stem` green on both platforms; fixture corpus passing through scanner + emu.
- A demo binary (`stem/examples/repl.rs`) that creates/attaches/kills sessions interactively — the manual smoke tool for Phase 2 development.

## Spec files to update

- New `bud/stem/stem.spec.md`; `bud/bud.spec.md` gains the workspace/member note; root `bud.spec.md` repo-layout table row.
