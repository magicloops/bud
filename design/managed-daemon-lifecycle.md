# Design: Managed Daemon Lifecycle (install → run → survive → upgrade)

> Scoping document for making the installed Bud daemon behave like a normal
> long-lived app for a standard user: it starts when installed, keeps running
> after the terminal closes and across reboots, and can be restarted with one
> obvious command — without the user hand-writing launchd plists or systemd
> units.

**Related Docs**:
- [self-serve-bud-install-command-and-local-mode.md](./self-serve-bud-install-command-and-local-mode.md)
- [bud-base-dir-and-local-identity.md](./bud-base-dir-and-local-identity.md)
- `DAEMON_INSTALLER_FOLLOW_UP_HANDOFF.md` (repo root, "User Service Install")

---

## 1. Executive Summary

The v1 installer ends with `Starting Bud in the foreground. Press Ctrl+C to
stop it.` That is correct for a first claim (the user must see the claim URL)
but wrong as the steady state: closing the terminal kills the daemon, nothing
restarts it, and the documented recovery today is a three-line env dance plus
a hand-written systemd unit with a non-obvious `KillMode=process` requirement.
A standard user should never see any of that.

Observed on the first real ARM install (2026-08-19): the install + claim flow
worked end to end, but "how do we restart it?" required assistant-level
knowledge of `bud.env`, holder kill semantics, and `loginctl enable-linger`.

### Recommendation

Ship **Option A (daemon-owned service management: `bud service install` +
lifecycle verbs)** as the primary path, with the installer invoking it by
default after a successful claim, and the foreground mode retained as an
explicit fallback (`bud run`). Defer self-supervision (Option C) and packaged
distributions (Option D) unless platform gaps make A insufficient.

Target UX:

```sh
curl -fsSL https://get.bud.dev | sh   # installs, claims, and *installs the service*
# later:
bud status                            # running / stopped, connected bud name, server
bud restart                           # obvious verbs, no systemctl/launchctl knowledge
bud logs [-f]                         # tail the daemon log
```

---

## 2. Problem Statement

What a standard user has to know today, and should not:

| Today | Should be |
|---|---|
| `set -a; . ~/.bud/bud.env; set +a; ~/.bud/bin/bud --terminal-enabled` | `bud start` |
| daemon dies with the terminal / on logout / on reboot | survives all three |
| write `~/.config/systemd/user/bud.service` with `KillMode=process` | generated for them |
| know that `loginctl enable-linger` exists | handled (or prompted) at install |
| kill by PID; know not to `pkill bud` (matches `bud term-hold` holders) | `bud stop` (never touches holders) |
| upgrades: re-run installer, then manually restart | `bud upgrade` restarts the service safely |
| no way to ask "is it running? as who? against which server?" | `bud status` |

Constraints that shape every option:

- **Holders must outlive the daemon.** Terminal sessions are detached
  `bud term-hold` processes; any supervision must restart the daemon without
  reaping holders (`KillMode=process` on systemd; launchd user agents do not
  kill detached children by default, but `AbandonProcessGroup=true` should be
  set defensively). The doctor already has a `supervision_directives` check
  for exactly this — it becomes load-bearing.
- **First run is interactive.** The claim URL/QR must be seen by a human, so
  "install service" cannot fully replace the foreground first run; the flow
  is claim in foreground → hand off to the service.
- **User-level, not root.** The install is per-user (`~/.bud`); launchd user
  agents and systemd `--user` units match that. Root/system services are out
  of scope.
- **Identity is sacred.** Stop/restart/upgrade/uninstall must never delete or
  regenerate `identity.json` implicitly (uninstall prompts explicitly).

---

## 3. Options

### Option A — Daemon-owned service management (recommended)

`bud service install|uninstall` generates and loads the platform service; thin
lifecycle verbs wrap the platform manager.

- `bud service install`:
  - macOS: writes `~/Library/LaunchAgents/dev.bud.daemon.plist`
    (`RunAtLoad`, `KeepAlive.SuccessfulExit=false`, `AbandonProcessGroup`,
    stdout/err to `~/.bud/logs/daemon.log`), `launchctl bootstrap gui/$UID`.
  - Linux: writes `~/.config/systemd/user/bud.service`
    (`EnvironmentFile=%h/.bud/bud.env`, `Restart=on-failure`,
    `KillMode=process`), `systemctl --user enable --now bud`, and runs
    `loginctl enable-linger` (prompting once if it needs the user's consent
    or sudo on hardened distros).
  - both: source env exclusively from `bud.env` so config edits have one home.
- `bud start|stop|restart|status|logs`: dispatch to
  launchctl/systemctl when the service is installed; fall back to
  pidfile-based management of a foreground-spawned daemon otherwise, so the
  verbs always work.
  - `status` reports: service state, daemon pid/uptime, bud name + server URL
    (from identity/env), last-connected state if cheaply knowable, holder
    count.
  - `stop` stops the daemon only — never holders; say so in the output
    ("terminal sessions keep running; they reattach on start").
- `bud run`: explicit foreground mode (today's behavior) for debugging and
  unsupported platforms.
- Installer change: after a successful claim (or immediately, when an install
  token pre-binds the claim), run `bud service install` and exit with
  `Bud is running in the background. Try "bud status".` Foreground bootstrap
  remains behind `BUD_INSTALL_FOREGROUND=1` and as the automatic fallback
  when no supported service manager is present.
- Doctor: extend `service_manager` / `supervision_directives` to validate the
  generated unit/plist content (drift detection after manual edits).

*Pros*: one obvious verb set; matches the handoff plan; unit/plist content is
testable as fixtures; no new supervision code to trust.
*Cons*: two platform integrations to maintain; linger/bootstrap edge cases
(SSH-only Linux boxes, macOS sandbox prompts) need real-host validation.

### Option B — Installer-managed service files only

The installer writes and loads the plist/unit itself; the daemon binary stays
lifecycle-ignorant; users interact with launchctl/systemctl directly.

*Pros*: no daemon changes; smallest diff.
*Cons*: restart guidance is still platform-specific (`systemctl --user
restart bud` vs `launchctl kickstart -k`); upgrades and uninstall must
re-implement the same logic in shell; nothing owns `status`. This is most of
the cost of A with little of the UX. Rejected as the end state; acceptable
only as A's internal implementation detail if we want shell-first iteration.

### Option C — Self-supervising daemon (fork/pidfile, no OS integration)

`bud start` double-forks, detaches, writes `~/.bud/bud.pid`; a watchdog
thread or `bud start --supervise` loop restarts on crash.

*Pros*: uniform across platforms, including ones with no service manager;
no linger problem.
*Cons*: does not survive reboot (the actual complaint); reimplements what
launchd/systemd do better; crash-loop and log-rotation policy become our
code. Keep only as the **fallback tier inside A's verbs** for unsupported
platforms — not as the primary mechanism.

### Option D — OS packages (Homebrew formula + service, deb/rpm)

`brew install bud && brew services start bud`; debs ship the systemd unit.

*Pros*: idiomatic per platform; auto-update via package manager.
*Cons*: a distribution program, not a fix — release matrix, signing, and
repo hosting per format; doesn't help the curl-install path that is already
live. Revisit post-launch as an *additional* channel (the handoff already
lists it under release hardening).

### Option E — Upgrade integration (rides on A)

`bud upgrade`: fetch stable manifest from get.bud.dev, compare version,
download + checksum-verify to a temp path, atomically swap
`~/.bud/bin/bud`, restart the service (holders survive; sessions reattach).
The installer already contains the fetch/verify logic; this moves it behind a
verb and closes the handoff's "upgrade behavior that restarts the service
safely". Auto-upgrade (timer/launchd interval) is explicitly out of scope for
the first pass — a stale daemon is better than a surprise restart until we
have restart-safety telemetry.

---

## 4. Proposed Scope (phased)

1. **Phase 1 — verbs + service install (Option A core)**
   - `bud service install|uninstall`, `bud start|stop|restart|status|logs|run`
   - generated plist/unit fixture tests (content snapshots per platform)
   - doctor validation of generated supervision directives
   - installer hands off to the service after claim; foreground fallback
2. **Phase 2 — upgrade verb (Option E)**
   - `bud upgrade` with manifest check + atomic swap + service restart
   - `bud status` shows "update available" from the stable manifest
3. **Phase 3 — polish**
   - uninstall flow with explicit identity handling
   - docs: supported platforms, service management, recovery
   - real-host validation matrix (macOS 13+ arm64/x64, Ubuntu x64/arm64,
     including the holder-survival rows from the existing findings)

Out of scope: root/system services, auto-update timers, OS packages (D),
multi-instance service management (`--local` buds stay foreground/manual until
the base-dir design lands).

## 5. Status

**Phase 2 (`bud upgrade`) implemented 2026-08-20**: manifest check,
checksum-verified atomic swap (ETXTBSY-safe rename), service restart with
holder survival, `--check` mode, and a best-effort update line in
`bud status`. Release builds now bake `BUD_BUILD_VERSION` so binaries know
their release tag; validated live against the promoted v0.1.6 manifest
(real download, real checksum, real install).


Phase 1 implemented on this branch (see
[plan/managed-daemon-lifecycle/phase-1-service-and-verbs.md](../plan/managed-daemon-lifecycle/phase-1-service-and-verbs.md)):
lifecycle module + verbs, `bud claim`, installer handoff, doctor
cross-validation. Real-host validation (macOS launchd + Ubuntu systemd,
reboot + holder-survival rows) still pending before the README documents the
flow.

## 6. Decision Record

**Device-secret storage (2026-08-19):** keep the 0600 `identity.json` file.
It matches the posture of ssh/AWS/kube credentials and is the only approach
that authenticates unattended at boot on both platforms (macOS Keychain ACLs
break on unsigned-binary upgrades and locked login keychains on headless
Macs; Linux keyrings are session-bound and absent on servers). The eventual
upgrade path, if warranted, is asymmetric device identity (Secure Enclave /
TPM2 challenge-response, server stores only the public key) as a device-auth
protocol evolution — not a keychain bolt-on for the shared secret. `bud.env`
itself carries no secrets (claim tokens are never persisted).

## 7. Open Questions

- Should `bud service install` run automatically on *tokenless* installs too,
  or only after a completed claim? (A daemon with no identity waiting in the
  background retries claim forever — probably fine, but the claim URL must be
  re-printable: `bud status` should surface a pending claim link.)
- Linger on Linux: prompt, auto-run, or document? `loginctl enable-linger`
  can require polkit auth on some distros.
- Naming: `bud service …` + top-level verbs, or everything under `bud
  daemon …`? Top-level `bud start/stop/status` reads best for normal users.
- Log policy: single file with size-based rotation in the daemon, or defer to
  journald/launchd stdout capture per platform?
