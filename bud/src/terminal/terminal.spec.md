# terminal

Daemon terminal runtime on `stem` (Bud's native terminal session manager).

## Purpose

Owns thread terminal sessions on the Bud host and implements the proto `0.3`
terminal contract (docs/proto.md §6.7). Sessions are persistent detached
holder processes (spawned by re-exec'ing the daemon binary as
`bud term-hold` through `stem::registry`); the daemon attaches with
`stem::Session`, which provides VT emulation, offset-exact ring replay, and
typed semantic events (OSC 133 command lifecycle, OSC 7 cwd, mode
classification, damage-quiet settling). The tmux backend, `TerminalBackend`
trait, capture hashing/deltas, and readiness-confidence machinery were
deleted in the Phase 2 cutover.

## Files

### `mod.rs`

Module composition; re-exports `TerminalConfig` and `TerminalManager`.

### `manager.rs`

`TerminalManager`: session lifecycle plus all `terminal_*` request handlers.

- `handle_ensure`: registry ensure (spawn or reuse holder, ring cap 8 MiB) →
  shim preparation → `Session::attach` with the service-supplied
  `resume_from_offset` (offset-exact backfill) → event pump spawn → proto 0.3
  `terminal_status` `ready` with `{pid, cwd, cols, rows, ring_next_offset,
  mode, integration}`. Re-ensure of a live session = reattach (drop the old
  attachment, attach fresh with the new resume offset). **Geometry invariant:**
  ensure `config.cols/rows` are a spawn-time hint only (used in the
  `SpawnSpec` for a fresh holder) — a surviving holder's PTY keeps its actual
  kernel winsize on reattach and is never resized from ensure config; only
  explicit `terminal_resize` changes a live PTY. The renderer owns geometry.
- `handle_send`: single gesture `{text?, submit?, key?, await?}`. Dispatch is
  serialized per session (tokio `Mutex<stem::Session>`); `submit` sends the
  literal text then a real Enter keypress (bracketed-paste safe). Awaited
  outcomes (`await: "command" | "settled"`) resolve off the pump's broadcast
  channel *after* the session lock is released, so slow commands never block
  other sessions/heartbeats (review finding D-H1). A daemon-internal 4h
  safety cap returns `error: "TIMEOUT"`; the service owns real timeout policy.
- Sentinel fallback (design D6c): submitted `await:"command"` text with no
  genuine OSC 133 evidence gets `; printf '\033]133;D;%s\a' "$?"` appended
  and `mark_sentinel_integration()`. The wrap decision keys off live `A`/`C`
  marker evidence (`genuine_osc133`), not the integration fact — reattach
  replay of earlier sentinel `D`s can mislabel a session `osc133`.
- `handle_observe`: emulator-grid-backed views — `screen` (full grid),
  `delta` (grid-diff v1: rows differing from the last observe/send snapshot),
  `history` (last N scrollback lines, default 200, cap 2000) — plus
  `mode`/`integration`/`alt_screen`/cursor facts.
- `handle_input`: raw browser keyboard bytes written verbatim to the PTY.
- `handle_resize` / `handle_close`: stem resize (+ status with new geometry)
  and holder kill (+ status `closed`, best-effort registry GC).
- Integration detection window: no OSC 133 marker within 5s of attach →
  `mark_no_integration()` and a daemon-emitted `mode_changed` (stem swallows
  the ModeChange from its own override methods).
- `clear_sender` drops attachments (pump/detect tasks aborted); holders
  survive and the service re-ensures with its committed offset on reconnect.
  Send/observe/input/resize can also re-attach to a surviving holder without
  spawning (resume from the current ring end).

### `session_task.rs`

Per-session event pump: `stem::Event` → proto 0.3 wire frames.

- `Output` → ≤16 KiB offset-addressed `terminal_output` chunks (no `seq`)
- `PromptReady`/`CommandStarted`/`CommandFinished` → `terminal_event`s with
  daemon-minted `cmd_<ULID>` ids; `duration_ms` from the started→finished
  interval, omitted for finish-without-start (sentinel-only)
- `ModeChanged`/`Settled`/`OutputGap` → matching `terminal_event`s
- `CwdChanged` → folded into `prompt_ready.cwd` and status info (no frame)
- `ChildExited` → `terminal_event child_exited` (+ signal name) followed by
  `terminal_status` `closed`
- feeds the internal broadcast channel (`PumpEvent`) that send-awaits
  correlate against, and keeps `SessionFacts` (mode, integration, marker
  evidence, ring offset, geometry, delta baseline) current

### `repl_registry.rs`

`BudReplRegistry`: the injected `stem::modes::ReplMatcher` (product policy).
Conservative prompt registry — python (`>>> `/`... `), irb, psql
(single-token `=#`/`=>`), mysql/MariaDB, sqlite, gdb/lldb/pdb. Plain `> `
and `% ` deliberately unmatched.

### `shims.rs`

Shell-integration shims (design D6b): zsh `ZDOTDIR` shim (sources the user's
real zshrc, then precmd/preexec OSC 133 A/C/D-with-`$?` + OSC 7 emitters),
bash `--rcfile` shim (sources `~/.bashrc`, then `PROMPT_COMMAND` +
DEBUG-trap emitters, bash-preexec technique), fish passthrough (native
≥3.6), everything else or `BUD_NO_SHELL_INTEGRATION=1` unshimmed. Shim files
are written under `<session dir>/shim/` at ensure.

## Dependencies

- [`stem`](../../stem/stem.spec.md) — registry/holder lifecycle, `Session`,
  events, key encoding
- [../protocol.rs](../protocol.rs) — 0.3 frame types and outbound builders
- [../transport.rs](../transport.rs) — outbound frame delivery
- [../app.rs](../app.rs) — spawns the handlers per frame (never inline) and
  asks for the session cwd before file opens with terminal context

## Tests

- unit: pump event mapping (chunking/ULIDs/durations/child-exit), grid-diff
  delta, REPL registry, shim generation, env defaults, sentinel trailer shape
- integration (`tests/terminal_stem.rs`, real holders via
  `CARGO_BIN_EXE_bud term-hold`): ensure→ready, sentinel `terminal.run` exit
  codes 0/1 on `/bin/sh`, observe/resize, close kills holder, offset-exact
  reattach (no dup/no gap), two-session non-blocking concurrency (D-H1), and
  zsh/bash shim marker flows (skipped when the shell is absent)

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- The zsh shim does not replay the user's `.zshenv` from a custom original
  `ZDOTDIR` (only `.zshrc`); acceptable approximation until reported.
- Overlapping sentinel-wrapped commands on one session are inherently
  ambiguous to correlate; the service serializes terminal tool calls today.
- stem API gaps tracked for a follow-up: `Session` does not expose
  `integration()` or ring stats, and `mark_no_integration()` /
  `mark_sentinel_integration()` swallow their ModeChange (daemon re-emits).

---

*Referenced by: [../src.spec.md](../src.spec.md)*
