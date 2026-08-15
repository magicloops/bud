# holder-survival

Phase 0 spike harness that produces the go/no-go evidence for the native terminal
session manager's holder-process persistence model: does a detached PTY-holder
process survive daemon crash, service-manager restart, and binary-replace upgrade
under macOS launchd (LaunchAgent) and Linux systemd (user unit)?

## Purpose

Design D2 proposes a detached holder process per terminal session (PTY + ring buffer,
daemon reattaches over a Unix socket); D3a flags launchd/systemd process-group and
cgroup teardown as the design's highest risk. This spike approximates the holder
mechanics with a minimal standalone Rust binary and drives it through the survival
scenario matrix. It is **not** the real implementation: the UDS protocol is a trivial
line protocol (the real one is framed postcard, D3c), and the PTY layer is raw `nix`
openpty (production intends `portable-pty`, D4) — neither difference affects what is
being measured (process survival and reattach).

Standalone cargo project on purpose: it is not a member of the `bud/` package or any
workspace (`[workspace]` table in `Cargo.toml` seals it off).

## Files

- [Cargo.toml](./Cargo.toml) - standalone package manifest; deps: `nix`, `libc`, `base64`, `serde`/`serde_json`.
- [src/main.rs](./src/main.rs) - CLI dispatch (hand-rolled argv) plus the `fake-daemon` (spawn-or-reattach daemon stand-in, re-invokes `current_exe` with the `holder` subcommand to mirror the production single-binary plan), `check` (3-criterion PASS/FAIL probe: holder pid alive, UDS HELLO round-trip, ring bytes strictly growing over 2.5s), and `stop` (KILL over UDS + cleanup confirmation) subcommands, and the shared UDS line-protocol client.
- [src/holder.rs](./src/holder.rs) - the detached child under test: double-fork daemonization (fork → setsid → fork, stdio to `holder.log`), `meta.json` `{pid, started_at, version:"spike-1"}`, real PTY (`nix::pty::openpty` + fork/exec of a `/bin/sh` 1s tick loop), PTY output appended to `ring.log`, and the `holder.sock` line protocol (`HELLO`/`STAT`/`TAIL n`/`WRITE base64`/`KILL`).
- [run-macos.sh](./run-macos.sh) - launchd scenario matrix for the human operator (job-exit, kill -9, `kickstart -k`, upgrade simulation; × `AbandonProcessGroup=true|false`); appends rows to `findings.md`. Prints manual instructions for logout/reboot rows.
- [run-linux.sh](./run-linux.sh) - systemd user-unit matrix (same scenarios × `KillMode=control-group|process`, plus a `systemd-run --user --scope` escape scenario). Written on macOS, **untested on Linux**.
- [findings.md](./findings.md) - how-to-run, the result matrix from the phase doc (cells pending), and the run log the scripts append to.
- [templates/launchagent.plist.tmpl](./templates/launchagent.plist.tmpl) - sed-able LaunchAgent template (`@ABANDON@` selects the `AbandonProcessGroup` variant; `@ONCE_ARG@` selects `--once` vs attach-loop mode).
- [templates/bud-spike-holder-survival.service.tmpl](./templates/bud-spike-holder-survival.service.tmpl) - sed-able systemd user unit template (`@KILLMODE@` variant placeholder); documents the `systemd-run --user --scope` alternative detach mechanism in comments.
- [.gitignore](./.gitignore) - `target/` and the runtime `run/` tree (installed binary copy, rendered plists/units, session dirs).

## Dependencies

- [../../plan/native-terminal-session-manager/phase-0-holder-survival-spike-and-proto-draft.md](../../plan/native-terminal-session-manager/phase-0-holder-survival-spike-and-proto-draft.md) - owning plan phase (§0.1); defines the matrix and exit criteria.
- [../../design/native-terminal-session-manager.md](../../design/native-terminal-session-manager.md) - D2 (holder persistence model), D3 (lifecycle/supervision risk this spike measures).

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Survival matrix not yet executed: `run-macos.sh` (human operator, GUI session) and `run-linux.sh` (untested on Linux) still need real runs; logout/reboot rows are manual. Results go to `findings.md`, recipe/no-go to design D3a.

---

*Referenced by: [../spikes.spec.md](../spikes.spec.md)*
