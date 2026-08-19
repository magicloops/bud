# PR: Managed daemon lifecycle — service install, lifecycle verbs, installer handoff

Branch `design/managed-daemon-lifecycle` → `main`. Makes the installed Bud
daemon behave like a normal long-lived app for a standard user: it starts
when installed, survives terminal close / logout / reboot, and is managed
with obvious verbs — no launchctl/systemctl/unit-file knowledge.

Design: [`design/managed-daemon-lifecycle.md`](./design/managed-daemon-lifecycle.md) (Option A)
· Plan: [`plan/managed-daemon-lifecycle/phase-1-service-and-verbs.md`](./plan/managed-daemon-lifecycle/phase-1-service-and-verbs.md)

**Trigger:** the first real ARM install (2026-08-19) worked end to end, but
restarting the daemon required assistant-level knowledge: a three-line env
dance plus a hand-written systemd unit with a non-obvious
`KillMode=process` requirement.

## What this PR does

### New user-facing surface

```sh
curl -fsSL https://get.bud.dev | sh   # install → claim (link/QR) → background service
bud status                            # manager, service state, pid, identity, server, holders
bud start / stop / restart            # stop never touches terminal sessions
bud logs [-n N] [-f]                  # uniform log tail on both platforms
bud service install | uninstall       # platform service management
bud claim                             # claim-only (exits after identity is written)
bud run                               # explicit foreground mode
```

### Implementation

- **`bud/src/lifecycle.rs`** — service-file generation and lifecycle verbs.
  - launchd user agent (`~/Library/LaunchAgents/dev.bud.daemon.plist`):
    sources `bud.env` through a `/bin/sh -c 'set -a; . bud.env; …'` wrapper
    (launchd has no `EnvironmentFile`), `RunAtLoad`,
    `KeepAlive.SuccessfulExit=false`, `AbandonProcessGroup=true`.
  - systemd user unit (`~/.config/systemd/user/bud.service`):
    `EnvironmentFile=-…/bud.env`, `Restart=on-failure`, **`KillMode=process`**
    — the directive validated by the holder-survival matrix; without it,
    every daemon restart reaps detached terminal holders.
  - Both write `~/.bud/logs/daemon.log`, so `bud logs` behaves identically.
  - `service install` loads the service (bootstrap / `enable --now`) and
    best-effort `loginctl enable-linger` on Linux (warns when polkit
    refuses). Identity is never touched by any lifecycle operation.
  - Verbs dispatch to the platform manager when the service file exists;
    otherwise a pidfile fallback: detached `setsid` spawn with env parsed
    from `bud.env`, SIGTERM to the daemon pid only — never process groups.
- **`bud claim`** (`BudApp::claim_only`) — runs the device-claim flow
  (link/QR interactive, or `BUD_CLAIM_ID` token redemption) and exits once
  `identity.json` is written. Already-claimed is a no-op success.
- **Installer** (`deploy/get-bud-dev/assets/install.sh`) — the bootstrap is
  now claim → `bud service install` → exit with a `bud status` hint.
  Foreground fallback when no service manager is usable;
  `BUD_INSTALL_FOREGROUND=1` preserves the old behavior exactly.
- **Doctor as drift detector** — the generated plist/unit are
  cross-validated in tests against the doctor's own supervision parsers
  (`AbandonProcessGroup`, `KillMode=process`), so the generators can never
  emit a service file the doctor would flag.

### Decision recorded

Device-secret storage stays the 0600 `identity.json` file (ssh/AWS-style;
the only unattended-boot-compatible option on both platforms). The eventual
upgrade path is Secure Enclave / TPM2 challenge-response as a device-auth
protocol evolution — documented in the design doc's Decision Record.

## Validation

- Rust: full `bud` crate suite green (116), fmt + clippy clean. New unit
  tests: service-file content (holder-safe directives, env sourcing, log
  paths), doctor cross-validation, `bud.env` parser (installer quoting,
  escaped quotes).
- Installer: 15/15 `install-sh.test.mjs`, including the three bootstrap
  paths (claim+service, foreground fallback on service failure,
  `BUD_INSTALL_FOREGROUND=1`).
- Live smoke: `bud status` against a real `~/.bud` (identity, env server,
  holder count reported correctly).

**Still pending before README promises harden further** (tracked in the
design doc status): real-host validation — `bud service install` on a real
Ubuntu host (the ARM machine) and a macOS host, a reboot row, and a
holder-survival row (`bud restart` with a live terminal session).

## Deploy notes

- No schema, protocol, or web changes. Daemon + installer only.
- Ships with the next release tag; the promoted installer then performs the
  claim → service handoff on fresh installs. Existing installs adopt with
  `bud service install` after upgrading the binary.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
