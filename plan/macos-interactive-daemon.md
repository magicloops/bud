# Plan: Interactive macOS daemon scheduling

## Context
- [Incident and investigation](../debug/native-browser-sign-in-lifecycle.md)
- [Daemon source spec](../bud/src/src.spec.md)
- On the affected MacBook, closing remote viewers did not resolve native
  Chrome input lag. Changing the launchd job from Background to Interactive
  and relaunching restored responsiveness. The Mac was on battery; battery's
  independent effect has not been measured.

## Objective and scope
- Generate `ProcessType=Interactive` for every macOS Bud launchd installation.
- Preserve direct binary launch, environment loading, failure restart policy,
  and detached terminal-holder survival.
- Apply through existing install/start/restart/upgrade registration paths.
- No service, web, mobile, DB, wire protocol, or Linux scheduling changes.
- No new setting: terminal and browser interactions require responsiveness even
  when the daemon has no browser configured.

## Approach and risks
Change the shared plist generator and explain the policy in code and the spec.
Extend the existing supervision test to lock in Interactive along with its
existing launch and holder-safety assertions. Interactive permits responsive
execution; it does not introduce polling, continuous work, or real-time priority.
Power use under contention can differ; actual idle work should remain minimal.
Apple's policy reference:
https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5

## Validation
- User confirmed native Chrome responsiveness after the manual policy change.
- Run lifecycle tests, including macOS plist syntax validation.
- Build daemon and check Rust formatting and lint.
- No live service reload or real browser-profile mutation during automated checks.

## Rollout
Daemon-only release. `bud upgrade` invokes the new binary's service install;
macOS install/start/restart regenerate and reload the plist. Copying a binary
alone is insufficient: run the updated installed binary's `bud restart`.
Fresh Chrome processes must launch under the new job. Normal daemon shutdown
attempts to close owned Chrome; if an old Chrome remains, quit that Bud Chrome
normally before reopening. This patch does not guarantee orphan cleanup or
retroactively change surviving processes. Detached terminal holders intentionally
survive, retaining their existing process lifetime.

The previously reported orphaned headless Chrome and stronger shutdown/wait
guarantees remain a separate lifecycle investigation in the linked debug note.
No profile deletion, broad process killing, or migration is required.

## Spec files
- [x] `bud/src/src.spec.md`

## Status
Implementation complete. Validation passed: nine lifecycle tests (including
macOS `plutil` validation), `cargo build`,
`cargo clippy --lib --bin bud -- -D warnings`,
`rustfmt --edition 2021 --check src/lifecycle.rs`, and `git diff --check`.
