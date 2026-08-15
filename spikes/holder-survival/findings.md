# Holder Survival Spike — Findings

Phase 0 go/no-go evidence for design D2(b)/D3a: does a detached PTY-holder process
survive daemon restart/upgrade under macOS launchd and Linux systemd user services?

Owning phase: [`plan/native-terminal-session-manager/phase-0-holder-survival-spike-and-proto-draft.md`](../../plan/native-terminal-session-manager/phase-0-holder-survival-spike-and-proto-draft.md) §0.1.

## How to run

```bash
cd spikes/holder-survival
cargo build

# Local harness smoke (no service manager, safe anywhere):
BIN=./target/debug/holder-survival
DIR="$PWD/run/sessions/smoke"
$BIN fake-daemon --dir "$DIR" --once   # spawns detached holder, verifies, exits
$BIN check --dir "$DIR"                # holder survived the fake-daemon exiting
$BIN fake-daemon --dir "$DIR" --once   # reattaches (meta.json pid unchanged)
$BIN stop --dir "$DIR"                 # KILL over the UDS; confirms cleanup

# Full matrix (HUMAN OPERATOR ONLY — manipulates launchd/systemd user services):
./run-macos.sh    # macOS, from a GUI login session, not root
./run-linux.sh    # Linux, real systemd user session, not root — script is UNTESTED

# Logout/login and reboot rows are manual; each script prints instructions at the end.
```

Each automated scenario appends a row to the Run log below. Transfer the conclusions
into the Result matrix by hand (each cell: child survives? UDS reconnect works? PTY
still live? — which is exactly what `check`'s three PASS/FAIL lines report — plus the
config variant that made it pass).

## Result matrix

| Scenario | macOS launchd (LaunchAgent) | Linux systemd (user unit) |
|---|---|---|
| Supervised job exits naturally (`--once`) | **SURVIVED** — pid alive, UDS reconnect OK, PTY live (both `AbandonProcessGroup` variants) | not yet run |
| Daemon process crash (`kill -9`) | **SURVIVED** — all three checks pass (both variants) | not yet run |
| Service-manager restart (`launchctl kickstart -k` / `systemctl --user restart`) | **SURVIVED** — reattach proven, holder pid unchanged (both variants) | not yet run |
| Daemon binary replaced, then restart (upgrade simulation) | **SURVIVED** — reattach across new-inode binary, holder pid unchanged (both variants) | not yet run |
| User logout/login (document behavior; not necessarily required to survive) | not yet run (manual) | not yet run (manual) |
| Machine reboot (expected: sessions die — confirm clean registry GC) | not yet run (manual) | not yet run (manual) |

### macOS conclusion (2026-08-15 run, Darwin 24)

**GO for the required rows: 8/8 PASS.** Key finding: survival held with
`AbandonProcessGroup=false` as well as `true` — the double-fork + `setsid` detach alone
removes the holder from the launchd job's process group, so the plist directive is not
load-bearing on macOS. Recommended recipe for `plan/daemon-readiness` templates anyway:
keep `AbandonProcessGroup=true` as defense-in-depth (macOS-version behavior drift is
cheap to insure against), and rely on the daemonization mechanics as the primary
guarantee. Remaining macOS rows (logout/login, reboot) are documentation-only and do not
gate the go/no-go. **Overall Phase 0 go/no-go still pends the Linux matrix.**

Config variants exercised by the scripts:

- launchd: `AbandonProcessGroup=true` vs `false` (each automated scenario runs both).
- systemd: `KillMode=control-group` vs `process` (each automated scenario runs both),
  plus a `systemd-run --user --scope` escape scenario with hostile `KillMode=control-group`.
- Extra scenario beyond the matrix rows: `job-exit` — holder survival across the
  supervised job simply finishing (`fake-daemon --once` exits) — since that is the
  steady-state production shape for spawn-then-detach.

## Exit criteria (from the phase doc)

- A documented supervision recipe per platform (exact plist/unit directives) under
  which all required rows pass, **or** a written no-go.
- No-go path: fall back to design D2(d) (tmux control mode); the plan is re-scoped
  before any Phase 1 work.
- Winning directives feed `plan/daemon-readiness` service templates in Phase 3.

## Run log (appended by run-macos.sh / run-linux.sh)

| Timestamp (UTC) | Platform | Scenario | Variant | Result | Note |
|---|---|---|---|---|---|
| 2026-08-15T06:49:24Z | macOS launchd | job-exit | AbandonProcessGroup=true | PASS | holder after natural job exit |
| 2026-08-15T06:49:31Z | macOS launchd | kill9 | AbandonProcessGroup=true | PASS | holder after daemon kill -9 |
| 2026-08-15T06:49:48Z | macOS launchd | kickstart | AbandonProcessGroup=true | PASS | reattached, holder pid unchanged (18758) |
| 2026-08-15T06:49:56Z | macOS launchd | upgrade | AbandonProcessGroup=true | PASS | reattached across binary replacement, holder pid unchanged (18845) |
| 2026-08-15T06:50:03Z | macOS launchd | job-exit | AbandonProcessGroup=false | PASS | holder after natural job exit |
| 2026-08-15T06:50:10Z | macOS launchd | kill9 | AbandonProcessGroup=false | PASS | holder after daemon kill -9 |
| 2026-08-15T06:50:26Z | macOS launchd | kickstart | AbandonProcessGroup=false | PASS | reattached, holder pid unchanged (19009) |
| 2026-08-15T06:50:34Z | macOS launchd | upgrade | AbandonProcessGroup=false | PASS | reattached across binary replacement, holder pid unchanged (19095) |

## Notes

- 2026-08-14: harness smoke test passed on macOS (Darwin 24) with no service manager
  involved: holder survived fake-daemon exit, second fake-daemon reattached with
  unchanged meta.json pid, WRITE/TAIL round-tripped through the real PTY, and `stop`
  cleaned up (holder + PTY child gone, socket removed).
- `run-linux.sh` was written on macOS and has NOT been executed on Linux yet.
- 2026-08-15: the script appends run-log rows to end-of-file; the eight macOS rows were
  moved up into the Run log table by hand (a `run-macos.sh` cosmetic quirk, results
  unaffected).
