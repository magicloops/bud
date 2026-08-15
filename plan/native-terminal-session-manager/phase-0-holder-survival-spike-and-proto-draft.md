# Phase 0: Holder Survival Spike, Emulator Bake-off, Proto Draft

**Gates the entire project.** Nothing in Phases 1–3 starts until the survival spike returns **go**.

Design refs: D2 (persistence), D3 (holder lifecycle/supervision), D5 (emulator), D15a (wire revision).

## Objective

Three independent deliverables, parallelizable:

1. **Go/no-go evidence** that a detached child process survives daemon restart/upgrade under macOS launchd and Linux systemd user services.
2. **Emulator decision** between `wezterm-term` and `alacritty_terminal`, recorded in the design doc.
3. **Drafted proto revision** in `docs/proto.md` for the D15a terminal contract.

## Work items

### 0.1 Holder survival spike (`spikes/holder-survival/`)

Build a minimal harness — a fake "daemon" that spawns a detached child (`setsid` + double-fork, stdio to a file) holding a PTY with a running `sleep`-loop shell, plus a UDS the fake daemon reconnects through.

Matrix to produce (each cell: child survives? UDS reconnect works? PTY still live?):

| Scenario | macOS launchd (LaunchAgent) | Linux systemd (user unit) |
|---|---|---|
| Daemon process crash (`kill -9`) | | |
| Service-manager restart (`launchctl kickstart -k` / `systemctl --user restart`) | | |
| Daemon binary replaced, then restart (upgrade simulation) | | |
| User logout/login (document behavior; not necessarily required to survive) | | |
| Machine reboot (expected: sessions die — confirm clean registry GC) | | |

Config variables to test: launchd `AbandonProcessGroup=true|false`; systemd `KillMode=process|control-group`, `slice`/scope escape via `systemd-run --user --scope` as an alternative detach mechanism.

**Exit criteria:**
- A documented supervision recipe per platform (exact plist/unit directives) under which all required rows pass, **or** a written no-go.
- No-go path: fall back to design D2(d) (tmux control mode); this plan is re-scoped before any Phase 1 work.
- Findings recorded in `spikes/holder-survival/findings.md`; the winning directives feed `plan/daemon-readiness` service templates in Phase 3.

### 0.2 Emulator bake-off (`spikes/emulator-bakeoff/`)

- Record raw byte-stream fixtures (script/asciinema-style, stored as files): plain shell session with OSC 133 markers, `vim` open/edit/quit, `htop` running 10s, `codex` startup (the known-problematic TUI), `python` and `psql` REPL exchanges, a fast `yes`/`find /` flood, a UTF-8 + wide-char + emoji sample.
- Drive both crates with each fixture; compare: final grid vs expected, damage-region API ergonomics (what does "quiet" look like?), scrollback access, alt-screen flag exposure, cursor position, OSC passthrough hooks, resize behavior mid-stream, dependency weight/compile time, API stability history.
- **Exit criteria:** decision + rationale appended to design doc D5; the fixture corpus is kept — it becomes the Phase 1/2 regression suite (`stem/tests/fixtures/`).

### 0.3 Proto revision draft (`docs/proto.md`)

Draft (marked *proposed, not yet implemented*):
- `terminal_output`: offset-only addressing (drop `seq`), unchanged ≤16KB chunking and base64 payloads.
- `terminal_ensure`: adds `resume_from_offset` (service's last committed byte offset; daemon backfills from ring).
- New `terminal_event` frame: `prompt_ready`, `command_started{command_id}`, `command_finished{command_id, exit_code, duration_ms}`, `mode_changed{mode}`, `settled`, `child_exited` — snake_case per conventions, ULID `command_id` minted by the daemon.
- `terminal_send_result` slimmed to transport ack + optional awaited terminating event; `keys` compat alias removed.
- SSE section: `terminal.event` browser event; browser resume semantics (last-applied offset in, backfill out).
- Explicit note on idempotency expectation for re-delivered output chunks (service `(session_id, byte_offset)` PK; design open question 5).

**Exit criteria:** reviewed draft merged to `main` with *proposed* status; Phases 1–2 build against it.

### 0.4 (Optional, parallel) Sentinel validation on current tmux backend

Wrap agent commands with `; printf '\033]133;D;%s\007' $?` and detect the marker in the pipe-pane log to validate the deterministic-command UX (agent prompt shape, exit-code plumbing worth) before stem exists. Throwaway; do only if Phase 1 is blocked on the spike for more than a few days.

## Test plan

The spike *is* the test. Each matrix cell must be reproducible via a script checked into the spike folder (`run-macos.sh`, `run-linux.sh`), not hand-run once.

## Spec files to update

- `spikes/spikes.spec.md`: add both spike folders.
- `design/native-terminal-session-manager.md`: D5 decision recorded; D3a recipe recorded.
- `docs/proto.md`: proposed revision section.
