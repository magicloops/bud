# Plan: Managed Daemon Lifecycle — Phase 1 (service install + verbs)

## Context
- Design doc: [design/managed-daemon-lifecycle.md](../../design/managed-daemon-lifecycle.md) (Option A)
- Related spec files: `bud/src/src.spec.md`, `bud/bud.spec.md`,
  `deploy/get-bud-dev/get-bud-dev.spec.md`
- Trigger: first real ARM install (2026-08-19) — restart required hand-written
  systemd units and env plumbing.

## Objective
A standard user installs Bud, approves the claim, and afterwards manages the
daemon with `bud start|stop|restart|status|logs` — no launchctl/systemctl
knowledge, daemon survives terminal close and reboot, holders survive daemon
restarts.

## Design / Approach
- New `BudCommand` variants: `Claim`, `Run`, `Start`, `Stop`, `Restart`,
  `Status`, `Logs`, `Service {install|uninstall}`. No subcommand = current
  foreground daemon (back-compat with existing service files and installer).
- New module `bud/src/lifecycle.rs`:
  - `ServiceManager::detect()` → Launchd | SystemdUser | None.
  - Generated launchd plist (`~/Library/LaunchAgents/dev.bud.daemon.plist`):
    `/bin/sh -c 'set -a; . bud.env; set +a; exec <bin> --terminal-enabled'`
    (launchd has no EnvironmentFile), `RunAtLoad`,
    `KeepAlive.SuccessfulExit=false`, `AbandonProcessGroup=true`, stdout/err →
    `<base>/logs/daemon.log`.
  - Generated systemd user unit (`~/.config/systemd/user/bud.service`):
    `EnvironmentFile=-<base>/bud.env`, `Restart=on-failure`,
    **`KillMode=process`** (holder survival), `StandardOutput/Error=append:`
    the same log file so `bud logs` is uniform across platforms.
  - `service install` writes + loads (bootstrap/enable --now), best-effort
    `loginctl enable-linger` on Linux with a warning when it fails.
  - Verbs dispatch to the platform manager when the service file exists;
    otherwise pidfile fallback (`<base>/bud.pid`, detached spawn with env from
    `bud.env`, SIGTERM to that pid only — never process groups, never
    holders).
  - `status`: manager kind + state, daemon pid, identity summary (or "not
    claimed" + hint), server URL, holder count; `logs [-n] [-f]` tails the log
    file.
- `bud claim`: load-or-create installation id, reuse
  `BudApp::bootstrap_device_auth`, persist identity, exit 0 (already-claimed =
  no-op success). Enables installer handoff.
- Installer: after install + doctor, `bud claim` (foreground, prints QR/link)
  → `bud service install` → exit with status hint. `BUD_INSTALL_FOREGROUND=1`
  or no supported service manager → today's foreground `exec`.
- Doctor `supervision_directives`: when the generated unit/plist exists,
  validate holder-safe directives (KillMode=process / AbandonProcessGroup).

## Spec Files to Update
- [x] `bud/src/src.spec.md` (new module + CLI surface)
- [x] `bud/bud.spec.md` if the CLI table is described there
- [x] `deploy/get-bud-dev/get-bud-dev.spec.md` (installer flow)
- [x] design doc status note

## Impacted Contracts
- [ ] WSS protocol — none
- [ ] SSE events — none
- [ ] DB schema — none
- [x] Installer bootstrap behavior (`install.sh`) + its tests
- [ ] Web UI — none

## Test Plan
- Rust unit tests: plist/unit content snapshots (holder-safe directives, env
  sourcing, log paths), env-file parser, pidfile helpers, CLI parse of new
  verbs.
- `install-sh.test.mjs`: bootstrap now calls `claim` then `service install`;
  foreground fallback path still covered.
- Real-host validation (deferred to rollout): macOS launchd + Ubuntu systemd
  rows incl. reboot and holder survival.

## Rollout
- Rides the next release tag; existing installs keep working (no-subcommand
  foreground unchanged) and can adopt via `bud service install`.
- Docs: README service section after real-host validation.
