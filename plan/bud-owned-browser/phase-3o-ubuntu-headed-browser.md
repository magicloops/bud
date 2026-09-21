# Phase 3o: Persistent headed browser on monitorless Ubuntu

Status: **Scoped; implementation and acceptance must run on an Ubuntu host.**
Updated 2026-09-21.

## Context and objective

Run the existing Bud-owned headed browser on an Ubuntu machine with no physical
monitor or interactive desktop login. Users view and control page content through
the existing web pane. Preserve one persistent profile per Bud, thread-owned tabs,
shared sign-ins, browser-wide private control, and explicit saved-URL recovery.

Depends on [3k shared persistence](phase-3k-shared-persistent-browser.md),
[3l page recovery](phase-3l-tab-and-history-recovery.md), and the existing viewer.
[3m native presentation](phase-3m-background-headed-browser.md) is macOS-specific;
its minimization/landing-tab workaround is not a Linux requirement.
[3n appearance](phase-3n-bud-color-sync.md) should retain launch-only semantics.
See [the roadmap](phases.md) for scheduling.

Related specs: [daemon](../../bud/bud.spec.md),
[browser](../../bud/src/browser/browser.spec.md),
[source and doctor](../../bud/src/src.spec.md),
[service browser](../../service/src/browser/browser.spec.md), and
[web browser](../../web/src/features/browser/browser.spec.md).

Headed Chrome needs a display server, not a physical monitor. Xvfb is the initial
virtual-display candidate; [Playwright documents headed Linux execution with
Xvfb](https://playwright.dev/docs/ci#running-headed). This does not establish Bud
compatibility: capture, input, storage, and unattended lifecycle need host tests.

The concrete current blocker is `profile::secure_storage_ready`: non-macOS
persistent launches return `browser_secure_storage_unsupported`. Merely setting
`DISPLAY` or removing this check is insufficient. The macOS readiness check and
window behavior should remain unchanged.

## Product and ownership contract

- The Bud browser resource continues owning the profile/process; threads own tab
  workspaces. The authenticated viewer and existing service authorization remain
  authoritative for page access, private input, and Return to agent.
- Run as a dedicated non-root OS user with a private display and session bus.
  Do not attach to a personal desktop, browser profile, or another user's bus.
- Retain browser sandboxing, loopback-only CDP discovery, profile locks, private
  filesystem permissions, and current unknown-action/no-replay behavior.
- Agent viewing remains operation-driven; private control retains live capture.
  A virtual display is not a reason to add polling or alter capture budgets.
- Remote page input works through the pane. Native file pickers, keyring unlock
  dialogs, passkeys, and desktop interaction are not newly supported. Native
  Show/Hide remains unavailable unless a separate supported desktop path exists.
- No new route, table, identity, lease, agent tool, or viewer protocol is planned.
  Existing owner stamping and authorization checks remain in force.

## Implementation sequence on Ubuntu

### 1. Establish a reproducible host and launch fixture

Record Ubuntu release, CPU architecture, kernel, Chrome distribution/version,
Node/helper versions, service revision, and daemon revision. Choose one supported
Ubuntu LTS/architecture and browser build first; do not promise all Linux variants.
Verify executable availability and install browser runtime libraries/fonts using
the chosen distribution's documented packages. Document any Snap/confinement
constraints rather than assuming an executable path behaves like the macOS one.

Create a disposable profile and local deterministic page fixture. Launch headed
Chrome under Xvfb with a fixed initial screen size/depth and authenticated local
X access; keep display TCP access disabled. First use a simple host wrapper for
experiments, not a new daemon display-management subsystem. Keep the existing
startup probe headless, but make doctor/readiness distinguish a successful
headless probe from actual headed-display and secure-store readiness.

### 2. Implement and verify Linux secure storage

Evaluate a Secret Service provider (initial candidate: GNOME Keyring) on the
same user's D-Bus session as Chrome and Bud. Verify Chrome actually selects that
backend on the pinned build. Choose a minimal Linux implementation of the current
secure-storage readiness contract; do not create a generic credential framework.

Test absent service, unavailable bus, locked collection, failed unlock, and a
backend disappearing after preflight. Check actual Chrome behavior, including
whether it can silently fall back after a successful readiness check. Enable
persistent launch only once the selected backend's failure behavior is understood
and enforced. Never use `--password-store=basic` or a mock keychain for the real
persistent profile; disposable tests must not be mistaken for that validation.

Document provisioning and unlock as an explicit operator step. Decide whether
unattended boot is supportable with the chosen host secret mechanism. Do not store
an unlock password in launch arguments, checked-in files, logs, or the browser
profile. If secure unattended unlock is unavailable, report that manual unlock
is required and leave browsing unavailable until then. Preserve existing profile
data when storage is locked/unavailable; do not reset it as recovery.

### 3. Validate rendering and interactions before changing defaults

Use headed Chrome on the virtual display without macOS minimization or the idle
landing-tab workaround. Test two thread tabs, navigation, inactive-tab screenshots,
semantic snapshots/click/fill, pane typing/scrolling, viewport fitting, popup
ownership, and long idle periods. Verify changed screenshot contents and actual
page state, not only successful command dispatch.

Only add a lightweight window manager or Linux-specific presentation handling if
a recorded fixture proves it necessary. Keep any change in the existing adapter;
no blanket foreground activation, screenshot-triggered window toggling, or
unbounded retry loop. Headless mode and macOS must retain their current behavior.

### 4. Make host lifecycle reproducible

After the fixture works, supply a small runbook and launch/service configuration
using the existing daemon installation path. Define ownership, startup order,
readiness, and teardown for Xvfb, the user bus/keyring, and Bud. Evaluate a systemd
user service with lingering where appropriate; lingering alone does not unlock a
keyring. Pin `DISPLAY`, X authorization, runtime directory, bus access, and private
profile storage for that user. Avoid spawning another X server per thread.

Test SSH logout, daemon restart, machine reboot, display loss/restart, keyring
loss, browser crash, and a second daemon attempting the same profile. Dependencies
must fail with actionable diagnostics, not misleading private-control expiry.
Display recovery must not replay unknown actions or auto-return private authority.
Never delete Chrome singleton locks or kill unrelated browser/display processes.

### 5. Exercise the actual agent and publish the supported setup

Run the actual service/agent/web workflow from another machine against the Ubuntu
Bud. Complete a private login, return control, and read the signed-in site from a
second thread. Repeat after daemon restart and host reboot with the documented
unlock procedure. Recovery remains explicit saved-URL reopening, not exact live
tab/history/form restoration. Verify Stop preserves the profile and Reset removes
its local data under existing authority rules.

## Acceptance and evidence

- [ ] Reproducible installation on the chosen Ubuntu/browser versions without a
  physical monitor or logged-in desktop; non-root sandboxed Chrome stays usable.
- [ ] Missing/locked/failed secure storage blocks safely and diagnostically;
  working storage retains sign-in across launches without insecure fallback.
- [ ] Two threads share sign-ins but retain target ownership; private takeover
  fences both agents and other viewers; Return resumes only through existing flow.
- [ ] Initial/reconnected frames, inactive tabs, client-rendered pages, private
  input, fitting, and popups work or have explicit measured limitations.
- [ ] Daemon/service/browser/display restarts and reboot preserve the intended
  profile/recovery behavior; duplicate process/profile ownership is rejected.
- [ ] At least a 30-minute soak measures CPU/RSS, screenshot duration, frame age,
  input-to-visible-update latency, and terminal latency under browser load.
  No continuous agent-mode capture, backlog, or reconnect storm while idle.
- [ ] Bud color/name/avatar behavior is checked on this Chrome distribution;
  appearance failure remains cosmetic and never destroys profile contents.
- [ ] Focused Linux regressions and builds pass; existing macOS tests still pass.
  Record exact commands/results and remaining gaps in a linked debug note.

The implementation is not complete merely because Chrome launches under Xvfb.
Secure storage, unattended lifecycle expectations, and actual-agent acceptance
are required gates. An unattended reboot limitation must be explicit in support
status rather than hidden behind a passing manual-login test.

## Documentation, contracts, and rollout

Update daemon/browser and source/doctor specs, daemon setup documentation, and
installer/service guidance where changed. Update dependency declarations and specs
if a Linux D-Bus client is added. Register new source files in their parent specs.
Update service/web specs and `docs/proto.md` only if an evidenced capability or
error-contract change is needed. Add owner-isolation validation to the auth
checklist if browser-facing paths change. No DB migration is expected.

Prefer host setup and daemon-only support using the current wire contract. In that
case an existing service works with an upgraded Ubuntu daemon, and an existing
Ubuntu daemon retains its explicit unsupported result with a newer service.
Require `bud upgrade` plus the documented host dependencies for Linux support.
If a cross-tier change proves necessary, document the rollout before implementing
it; use the agreed coordinated prelaunch browser rollout rather than an alternate
legacy lifecycle. Keep Linux availability disabled until its readiness gates pass.

## Scope and debt boundaries

No embedded X server supervisor, new browser backend, remote-desktop/VNC product,
WebRTC, GPU/video acceleration project, automatic downloads during agent calls,
personal-browser attachment, CAPTCHA guarantee, full history restoration, or
Linux distribution abstraction. Remote desktop may be an operator-managed
troubleshooting aid, not a prerequisite for normal page interaction or a new Bud
control channel. Start with one validated host configuration and reuse the current
profile, control, media, and recovery paths.
