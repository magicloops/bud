# Phase 4: Installer Preflight And User Service

> **Supersession note (2026-08):** The tmux dependency described in this phase
> was removed by the `stem` cutover
> ([plan/native-terminal-session-manager](../native-terminal-session-manager/implementation-spec.md)).
> Terminal sessions are now provided by detached `bud term-hold` holder
> processes — the install is single-binary and no tmux preflight or
> remediation exists. The tmux-specific steps below are retained as history;
> the service-template directives marked REQUIRED below are the current
> mandatory contract (validated by
> [spikes/holder-survival/findings.md](../../spikes/holder-survival/findings.md)).

## Objective

Build the public shell installer and user-service integration.

The installer should install Bud safely, explain host dependency problems locally, and start the daemon as a user-level service on supported systems.

## Installer Contract

Public command:

```bash
curl -fsSL https://get.bud.dev/install.sh | sh
```

Authenticated command:

```bash
curl -fsSL https://get.bud.dev/install.sh | env BUD_CLAIM_ID='bic_...' sh
```

Supported flags:

- `--foreground`: install/configure, then run in the current terminal instead of installing a user service
- `--no-start`: install/configure but do not start
- `--channel stable`: default channel
- `--local`: developer/advanced mode only after Phase 1 base-dir/local work exists
- `--base-dir PATH`: advanced override

Do not include `--install-deps` in v1 unless the team explicitly accepts package-manager automation risk.

## Installer Steps

1. Detect OS and architecture.
2. Reject unsupported OS/arch with clear text.
3. Fetch `https://get.bud.dev/releases/stable/manifest.json`.
4. Select matching artifact.
5. Download artifact to a temporary directory.
6. Verify SHA-256.
7. Unpack the binary.
8. Install to `~/.bud/bin/bud`.
9. Write production config under the effective base dir.
10. Preserve any existing identity/config unless an explicit safe upgrade path applies.
11. Run `bud doctor`.
12. Print tmux remediation and stop or continue with terminal capability disabled according to the final policy. *(Superseded by the stem cutover: no tmux dependency exists; `bud doctor` now runs registry/holder-smoke/supervision-directive checks instead.)*
13. Install and start the user service on supported platforms, unless foreground/no-start was requested.
14. Print status, log path, and next step.

## Tmux Policy

> **Superseded (stem cutover):** this whole section no longer applies — Bud
> ships its own terminal holder (`bud term-hold`) and has no tmux dependency.
> See [plan/native-terminal-session-manager](../native-terminal-session-manager/implementation-spec.md).

V1 installer does not install tmux automatically.

If tmux is missing:

- show the OS-specific command
- explain that Bud terminal control requires tmux
- do not report a fully ready terminal-capable install
- allow a documented non-terminal start only if the product explicitly accepts degraded capability

Recommended v1 behavior: stop before starting the service when terminal support is expected and tmux is missing.

## User Service Management

Add daemon subcommands or installer-managed equivalents:

- `bud service install`
- `bud service start`
- `bud service stop`
- `bud service restart`
- `bud service status`
- `bud service uninstall`

### macOS launchd

Install a per-user LaunchAgent:

- path: `~/Library/LaunchAgents/dev.bud.daemon.plist` or final bundle id
- runs `~/.bud/bin/bud` with config/base-dir arguments or env
- starts at login
- keeps alive after failure with reasonable throttling
- logs to `~/.bud/logs/`
- **REQUIRED:** `<key>AbandonProcessGroup</key><true/>` — defense-in-depth so
  detached terminal holders (`bud term-hold`) are never reaped with the daemon
  job; validated in [spikes/holder-survival/findings.md](../../spikes/holder-survival/findings.md)
  (survival held without it on current macOS, but the directive is mandatory in
  shipped templates). `bud doctor` warns when an installed bud plist lacks it.

Use `launchctl bootstrap gui/$UID ...` and `launchctl bootout gui/$UID ...` where available.

### Linux systemd user service

Install a user service:

- path: `~/.config/systemd/user/bud.service`
- runs `~/.bud/bin/bud` with config/base-dir arguments or env
- uses `Restart=on-failure`
- **REQUIRED (load-bearing):** `KillMode=process` under `[Service]` — the
  systemd default (`control-group`) kills every detached terminal holder on
  daemon stop/restart/upgrade, so sessions will not survive daemon restarts
  without it; validated in [spikes/holder-survival/findings.md](../../spikes/holder-survival/findings.md).
  `bud doctor` warns when an installed bud unit lacks it.
- starts via `systemctl --user enable --now bud.service`
- documents lingering if needed for non-login background behavior, but do not require privileged setup for v1

### Unsupported Linux

If systemd user services are unavailable:

- do not attempt OpenRC/runit/s6/supervisord setup in v1
- print foreground/manual instructions
- make unsupported-service status explicit in installer output

## Existing Install Handling

Installer must detect:

- existing `~/.bud/bin/bud`
- existing identity
- existing config
- running service
- mismatched install scope

Safe behavior:

- upgrade binary in place only when config/identity are compatible
- restart service after successful upgrade
- never delete identity during upgrade
- never overwrite an identity to redeem a new claim without a future explicit reclaim/account-switch flow

## Expected Files And Areas

- hosted `install.sh` source location, if checked into repo
- `bud/src/` service management module if implemented in Rust
- `bud/src/config.rs`
- `bud/src/identity.rs`
- release manifest consumer logic if shared with installer tests
- docs for install/update/uninstall

## Tests

Shell installer:

- shellcheck
- OS/arch detection fixture tests
- manifest parsing fixture tests
- checksum mismatch fails
- unsupported platform fails clearly
- existing identity is preserved

macOS:

- launchd install/start/status/stop/uninstall
- reboot/login persistence where feasible
- missing tmux flow

Linux:

- systemd user install/start/status/stop/uninstall
- missing tmux flow
- non-systemd foreground fallback

Daemon:

- `bud service status` reports useful service state
- `bud doctor` output is stable enough for installer use

## Spec Files To Update

- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- root install docs or README files touched by the installer
- `bud.spec.md` if new top-level deployment/install files are added

## Exit Criteria

- [ ] public install command downloads and verifies the right artifact
- [ ] install path is user-writable and deterministic
- [ ] existing identity/config are preserved
- [ ] missing tmux produces actionable local guidance
- [ ] macOS user service install/start/status/uninstall works
- [ ] Linux systemd user service install/start/status/uninstall works
- [ ] unsupported service managers fall back cleanly
- [ ] foreground mode works
