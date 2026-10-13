# Debug: Browser profile blocked after daemon upgrade

## Environment
- Installed macOS arm64 daemon v0.1.26, commit `84c98dbe7ae68f0a2197e78a2ca2a843d130608a`, connected to production.
- Production state under `~/.bud`; development uses the separate `~/.bud-dev` profile.
- Observed October 12–13, 2026. No database access was needed for this investigation.

## Repro Steps
1. Use a persistent Bud browser on the installed daemon.
2. Upgrade/restart the daemon.
3. Ask the agent to reopen Hacker News.

## Observed
- Agent `browser_exec` on 2026-10-13 at 05:58:14 UTC rejected with `browser_profile_recovery_required` and `execution_state:not_executed`.
- Installed binary reports v0.1.26; this is not an old-binary problem.
- Production Chrome PID 89674, started October 10 at 23:07:46 local time, is still alive with parent PID 1 and the exact production profile `--user-data-dir`.
- That profile's `SingletonLock` points to `mbp-m4.local-89674`; the local hostname matches. This is a live lock, not stale lock debris.
- At 2026-10-12 23:51:17 UTC, the old daemon logged failed `Target.getTargets` and `Browser.close` calls (transport/decode, send stage), plus an unavailable recovery checkpoint. The replacement connected at 23:51:28 UTC.
- A separate development Chrome PID 67844 uses `~/.bud-dev` and has a live parent; it is unrelated to the production singleton.
- Closing the production Chrome window did not terminate PID 89674. After revalidating the exact local singleton owner, executable, profile argument, and orphaned parent, a targeted SIGTERM terminated that process. The singleton symlink remained; the existing dead-PID cleanup can remove it on the next profile acquisition.
- The installed launchd job reports `exit timeout = 5`. The generated plist has no explicit `ExitTimeOut`; browser close alone waits five seconds before forced child termination and up to five more seconds for confirmation, in addition to CDP close and checkpoint work. The service-manager grace period is therefore shorter than the browser cleanup budget.

## Expected
An ordinary upgrade should finish closing the daemon-owned browser before replacing the daemon, preserving profile sign-ins. A new daemon should then reopen the profile without manual recovery.

## Hypotheses
- Confirmed immediate blocker: Chrome survived its owning daemon. `Profile::acquire` calls `ensure_singleton_free`, which correctly refuses a live matching Chrome with `browser_profile_recovery_required`.
- The failed shutdown CDP channel prevented graceful browser close. The precise reason the child survived escalation still requires a restart reproduction and shutdown/process timing evidence.
- Confirmed lifecycle budget mismatch: launchd can terminate the daemon before its browser shutdown escalates and confirms exit. This is a concrete candidate for the observed orphan; exact signal timing was not captured for the original upgrade.
- `Browser::close_owned` attempts CDP close, waits five seconds, kills its owned child, then waits another five seconds. Launchd service replacement uses bootout/bootstrap and intentionally abandons the process group so persistent terminal holders survive. Cleanup must complete before daemon termination; killing the entire group is not an acceptable solution.
- This is separate from browser-control lease renewal: profile admission rejects before the requested cell executes.

## Proposed Fix
- Implemented locally in [Phase 7: Browser-safe upgrade and restart](../plan/daemon-readiness/phase-7-browser-safe-upgrade-and-restart.md); installed upgrade acceptance remains pending.
- Immediate recovery: gracefully quit only the verified production Bud Chrome instance, confirm exit, and retry opening the page. Keep the profile and sign-ins; do not delete its live singleton lock or reset the profile. Closing Chrome ends its open tabs and may lose unsaved form edits, so obtain approval before doing it programmatically.
- Reproduce upgrade/restart with a disconnected CDP channel and observe daemon/child shutdown ordering. Bound service shutdown consistently with browser cleanup, and report incomplete cleanup explicitly.
- Set an explicit service-manager grace period that exceeds a bounded total browser shutdown budget. Make checkpoint failures/timeouts unable to prevent owned-process cleanup; confirm the original daemon has exited before replacement. Cover upgrade/restart with broken CDP, private control, slow page work, and persistent terminal holders.
- Improve profile-blocked diagnostics to distinguish live Chrome, foreign-host lock, malformed lock, and process-inspection failure, without page data or secrets.
- Preserve the refusal to attach blindly by stored PID/port. Any future orphan recovery needs verified process/profile ownership and an explicit lifecycle design.
- Related specs: `bud/src/browser/browser.spec.md`, `bud/src/src.spec.md`; service/DB/client changes are not established as necessary.

## Investigation Status
The verified orphaned production Chrome process was terminated gracefully after
the user's unsuccessful window-close attempt. No profile files were removed.
Phase 7 is now implemented in the working tree; the installed daemon has not
been replaced as part of implementation. Installed release upgrade, saved
sign-in and production takeover acceptance remain pending.

## Validation

- `cargo test --lib --quiet -- --test-threads=1`: 242 passed, 11 ignored; env-gated browser cases without
  an executable return early and are not counted as live acceptance.
- Explicit Chrome run of `live_poisoned_close_reopens_persistent_profile_without_reset` passed.
- Explicit Chrome run of `live_shutdown_preserves_profile_after_failed_checkpoint_and_private_control` passed for public/private states.
- `cargo test --test instance`: six cases passed, including real CLI stop/wait
  ordering with fake launchd and a real locked child taking six seconds to exit.
- `cargo test --test terminal_stem`: all 30 passed, including holder reattachment,
  output offset continuity and mid-TUI restart regressions.
- `cargo clippy --lib --tests -- -D warnings` passed after scoping an existing
  test's entries mutex before its await.

Build/check failures investigated during implementation:

- Initial `cargo test --lib lifecycle::tests` failed with `E0308` at
  `src/browser/adapter.rs:1713`: `expected (), found Result<(), Error>`.
  Fixed the root close branch's explicit return; rerun passed.
- `cargo clippy --lib --tests -- -D warnings` reported
  `clippy::await_holding_lock` at `src/browser/manager.rs:1876` in the existing
  failed-allocation test. Replaced explicit guard drop with a lexical block;
  the strict check passed. No production terminal code changed.
- One parallel `cargo test --lib --quiet` run hit `browser add-on installation
  busy` / `Resource temporarily unavailable (os error 35)` at `addon.rs:1108`
  during the existing repeated startup/repair test. Installation uses a
  nonblocking flock and the suite spawns processes concurrently; fork/exec lock
  inheritance is a possible contributor, not a proven cause. The affected test
  passed in isolation and the full suite passed serially. No add-on code changed.
- Changing `run_loop` to borrow the retained app exposed `E0596` at
  `src/app.rs:2007` in the existing retry-loop test (`app` was not mutable).
  Made the fixture binding mutable; the library suite and strict Clippy passed.
