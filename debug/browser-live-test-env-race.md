# Debug: intermittent failures in the env-gated live browser suite

## Environment
- macOS 24.6 (arm64, 16 cores), system Google Chrome 153.0.8010.53
- `cargo test --lib browser::` with `BUD_BROWSER_EXECUTABLE` set (41 live tests,
  default test parallelism = 16 threads)
- Daemon at branch `feat/bud-owned-browser`, after Phase 3s/3u and the legacy
  `observe` removal; no service or database involved

## Repro Steps
1. `cd bud && BUD_BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" cargo test --lib browser::`
2. Repeat; roughly one run in three failed before the fix below.

## Observed
- First sighting: `profile::tests::ownership_lock_and_profile_survive_reopen`
  panicked at a `read_to_string` of a file the test had just written. It passed
  alone, three times with its siblings, and 40 times under `--test-threads=32`.
- Subsequent runs failed in different live fixtures with
  `browser_launch_failed` and, once, an `Action::Open` returning not ok. The
  captured cause of the launch failure was
  `No such file or directory (os error 2)` from `Command::spawn` of the browser
  executable, whose path exists.
- No stray Chrome, helper or fixture processes; `ulimit -n` is 1,048,576 and the
  process count was far below the limit; no test changes the working directory.

## Hypotheses
1. Resource exhaustion under 16 parallel Chrome launches. Rejected: limits are
   nowhere near, and the spawn error is ENOENT, not EAGAIN/EMFILE.
2. A test mutating the process environment while other threads read it.
   `addon::tests::env_override_requires_the_helper_path` called
   `std::env::set_var("BUD_BROWSER_EXECUTABLE", "/tmp/chrome")` and
   `set_var("BUD_BROWSER_HELPER", "/tmp/main.mjs")`, then restored them. Every
   live fixture reads `BUD_BROWSER_EXECUTABLE` at launch through
   `addon::test_runtime`, so a launch that raced the window spawned
   `/tmp/chrome` and got ENOENT. This also explains the `Open` failure (same
   launch path) and is the most plausible cause of the profile read failure,
   although that one was not reproduced with a captured error.

## Fix
- `addon::env_override` now delegates to a pure `override_from(executable,
  helper, node)`; the unit test exercises the pure function and no daemon test
  mutates the process environment any more (verified by grep).
- After the fix: 17 of 19 consecutive live runs passed. The two remaining
  failures were a different class: fixture readiness polls. The Phase 3u
  `type=email` fixture (and the older password fixture it was copied from)
  polled `snapshot_nodes` with `unwrap()` while the page was still navigating;
  under 16 parallel Chrome launches the helper occasionally answered
  `browser_target_not_found` mid-navigation, which is expected during a
  navigation and not the behaviour under test. Both polls now tolerate a
  transient error and keep polling. One launch-unwrap failure in
  `live_screenshot_timeout_recovers_without_recovering_commands` happened
  after the environment fix, its cause line was not captured, and it did not
  recur in 14 further runs or in three runs alone. It remains unexplained; if
  it returns, capture the `Caused by` line before changing anything.
- After both changes: 3 of 3 live runs passed (41 tests each), lib suite 160,
  clippy and fmt clean. No product code changed for this investigation; the
  only non-test change is the pure `override_from` split.

## Spec files affected
- `bud/src/browser/browser.spec.md` (add-on section: tests never mutate the environment)
