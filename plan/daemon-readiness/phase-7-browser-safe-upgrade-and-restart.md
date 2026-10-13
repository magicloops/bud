# Phase 7: Browser-safe upgrade and restart

Status: implemented locally; deterministic and disposable-browser validation
completed. Installed old-version upgrade and production acceptance remain release gates.

## Context

- Incident: [Browser profile blocked after upgrade](../../debug/browser-profile-blocked-after-upgrade.md).
- Specs: [daemon source](../../bud/src/src.spec.md), [browser runtime](../../bud/src/browser/browser.spec.md), [daemon package](../../bud/bud.spec.md).
- Related work: [connection deadlines](../clean-close-reconnect/phase-4-connection-and-authentication-deadlines.md), [persistent browser](../bud-owned-browser/phase-3k-shared-persistent-browser.md), [stale singleton handling](../bud-owned-browser/phase-3s-confirmed-defects.md).

An installed v0.1.26 daemon could not reopen its profile after an upgrade.
Chrome survived its daemon and remained alive even after its last window was
closed. The new daemon correctly rejected the live singleton lock. Targeted
termination of the verified orphan resolved the immediate process blocker;
profile reuse still needs user acceptance.

The installed launchd job has a five-second exit timeout. Browser shutdown can
exceed that before forced child termination, with additional checkpoint and
lock waits. This budget mismatch is confirmed; the original event did not
capture enough process/signal timing to prove the precise orphan mechanism.

## Objective

Routine `bud upgrade`, `bud restart`, `bud stop`, and service reinstallation
finish browser cleanup before replacing the daemon. Broken CDP, a busy page,
or a failed checkpoint must not prevent owned Chrome termination.

Acceptance:

- Chrome exits and the next daemon can acquire the same profile without manual
  quitting, profile reset, lock deletion, or a second browser instance.
- Sign-ins and persistent profile contents survive; supported public URL
  checkpoints restore when available. Exact tabs/history, unsaved forms and
  interrupted private progress are not promised across restart.
- Persistent terminal holders and output offsets survive unchanged.
- Cleanup/replacement either completes within a documented budget or reports
  failure clearly. It never reports a successful restart after unconfirmed cleanup.

## Design / Approach

### 1. Reproduce and instrument the shutdown boundary

Capture shutdown admission fencing, checkpoint completion/skip, process-close
attempt, escalation, confirmed exit, and replacement startup. Use monotonic
elapsed times and fixed reason codes. Do not log page URLs, content, cookies,
credentials or CDP endpoints.

Reproduce a disconnected CDP channel during installed macOS restart and record
the launched child, singleton owner and service termination ordering. Check for
Chrome process replacement/relaunch as a separate possible contributor. Do not
assume that waiting for the original child proves the profile is unused.

### 2. Bound cleanup without canceling away process ownership

Use one total monotonic shutdown deadline, initially 30 seconds. Checkpointing
is best-effort with a small shared budget, initially five seconds total across
all workspaces. Skip checkpoints under private authority as today.

Fence new browser work first. Bound REPL draining and page-lock acquisition;
errors in those stages must still reach owned-process cleanup. Reserve enough
of the total budget for process termination and confirmation. CDP close is
best-effort and bounded; follow it with graceful owned-process termination and
then forced termination if necessary. Confirm exit before releasing profile
ownership. Keep the process handle accessible independently of a stuck page lock.

Do not wrap the whole cleanup future in a timeout and then drop it: that can
cancel the code responsible for terminating/reaping Chrome. Late capture or
page results remain fenced, and interrupted mutations are never replayed.

Keep singleton cleanup restricted to proven dead owners or confirmed termination
of the exact owned process. If the singleton still names a live process after
the child exits, report that mismatch; do not remove its lock or adopt its port.
If the reproduction proves Chrome relaunch is involved, scope verified process
identity handling before enabling any automatic termination of replacement PIDs.

### 3. Align lifecycle and supervisor timing

Generate explicit `ExitTimeOut=45` for launchd and `TimeoutStopSec=45` for
systemd. Keep `AbandonProcessGroup=true` and `KillMode=process`: terminal holders
must survive. Align pidfile-managed stop and CLI replacement waits with a
50-second outer budget, allowing shutdown plus supervisor bookkeeping.

Before launchd bootout/bootstrap for upgrade/reinstall/restart, request graceful
shutdown of the verified selected daemon and wait for its confirmed exit. This
also covers the first upgrade from an existing job with the old five-second
timeout: changing the plist on disk does not update the loaded job's timeout.
Confirm the old job is unloaded before bootstrapping the replacement; retain
the existing narrow bootstrap-race handling.

Use the existing instance lock, PID and service ownership checks; never signal
an unrelated daemon based only on a stale PID. Account for KeepAlive and daemon
failure/relaunch during the wait. An unexpected replacement or failed shutdown
must not be mistaken for a successful stop.

The updated binary already generates the service installation during upgrade.
Share lifecycle helpers so CLI restart, service install and upgrade do not drift.
Keep binary replacement atomic. If refresh fails after replacement, retain the
installed binary and report the precise recovery action; do not claim success.

Budget values are initial implementation defaults. Tests must demonstrate that
all cleanup stages fit inside them, including service-manager margin.

### 4. Scope and ownership

Daemon-only changes expected in `lifecycle.rs`, `app.rs`, browser `manager.rs`
and `adapter.rs`, with `upgrade.rs` changes only if its refresh/error reporting
needs adjustment. Existing base-directory and profile ownership remain intact.

No service, DB, web or mobile changes are required. No browser-facing route or
authorization changes. Do not add flags, profile resets, broad process-group
kills, blind CDP adoption or routine manual recovery instructions.

Automatic recovery after hard SIGKILL/power loss is separate work. Existing live
orphans may need one-time targeted recovery; this phase must not silently kill
an arbitrary process found in a singleton file.

## Test Plan

- Unit tests: generated supervisor budgets and terminal-preserving directives;
  lifecycle ordering, selected-instance checks, timeouts and failure reporting.
- Deterministic cleanup fixtures: healthy close, broken/silent CDP, failed
  checkpoint, stuck page lock, private control, failed REPL drain, delayed child
  exit and escalation. Verify cleanup still runs and late work cannot publish.
- Disposable real-Chrome tests: close with poisoned CDP, reopen the same profile,
  preserved profile sentinel, stale singleton handling and no surviving owned
  process. Capture whether the singleton owner differs from the spawned child.
- Installed macOS acceptance: upgrade from a job loaded with the five-second
  timeout, then repeated restart/stop/start with headed Chrome and an active
  terminal holder. Verify profile reuse, sign-ins, terminal PID/output continuity,
  correct binary version and effective launchd timeout.
- Systemd/pidfile fixtures: equivalent stop-before-replacement behavior without
  changing Linux persistent-browser support policy.
- Run relevant Cargo tests, formatting and strict Clippy. Record exact failures
  in the debug note and resolve them before calling validation complete.

## Spec Files to Update

- [x] `bud/src/src.spec.md`: lifecycle timing, first-upgrade behavior and failures.
- [x] `bud/src/browser/browser.spec.md`: bounded cleanup and ownership on exit.
- [x] `bud/bud.spec.md`: managed upgrade/restart guarantees and limitations.
- [x] `bud/tests/tests.spec.md`: existing instance/lifecycle fixture extended.
- [x] This plan and the debug note with implemented behavior and actual evidence.

## Implementation and validation

`lifecycle.rs` generates explicit 45-second supervisor budgets, protects loaded
old jobs by signaling and waiting before unload, confirms unload, and checks
profiles before replacement. Locked instance metadata and actual PID liveness
are both checked; a replacement or unverified running launchd PID rejects.
Systemd install/restart uses stop/verify/start after reloading the stop budget.
Pidfile fallback uses the same 50-second wait and profile verification.

`manager.rs` fences admission, bounds preparation and root acquisition, and
retains independent process ownership for fallback cleanup. `adapter.rs` shares
bounded CDP/process shutdown and verifies the singleton after reaping. It never
signals a PID discovered through a profile. `profile.rs` now treats failed/empty
process inspection as uncertain, rather than proof of a stale lock.
`app.rs` retains the app through final cleanup and closes its current manager;
identity re-claim uses a fresh manager while old task clones remain fenced.

Validation uses temporary state only: a real Chrome process with poisoned CDP
closes and reopens the same persistent profile; corrupt checkpoints and private
authority do not block cleanup or alter the profile sentinel. A child ignoring
SIGTERM is forcibly reaped without affecting an unrelated process. Busy REPL,
page and root locks still reach process cleanup. The real CLI fixture waits for
six-second cleanup before calling its fake launchd unload/bootstrap.

The full library suite, isolated CLI tests, terminal integration suite and strict
Clippy results are recorded in the linked debug note. Env-gated browser tests
were also run explicitly with the installed Chrome executable. These fixtures
do not substitute for an installed release-to-release upgrade, actual sign-in
retention or production takeover acceptance.

## Impacted Contracts

- Daemon lifecycle and generated service configuration change.
- WSS/SSE, DB schema, agent tools, web/mobile contracts: unchanged.
- Profile/sign-in integrity and persistent-terminal survival are required.

## Rollout

After implementation and acceptance, create a PR and release through the normal
separately authorized flow. No service deployment or client rebuild is needed.
Upgrade uses the updated binary's generator to install the new supervisor
settings, while explicit stop-and-wait protects the already-loaded old job.

Test an actual old-version-to-new-version upgrade before promotion. Existing
orphans are not fixed by a timeout setting alone; document verified targeted
recovery for affected hosts without deleting profiles. A release is complete
only after fresh browser opening and production takeover are verified afterward.
