# Debug: browser tab recovery (Phase 3l)

## Environment
macOS, Google Chrome 152.0.7977.83, Playwright Core 1.63.0. Disposable
headed profile, mock keychain, local HTTP fixture; no personal profile or daemon.

## Observed
The current daemon closes Chrome at shutdown. On the next boot, the service
retires nonprivate workspaces, and new workspaces create blank tabs. Cookies
survive but the pane cannot recover without an agent message.

Native restore experiment (`node /tmp/bud-3l-probe.mjs`): two duplicate-URL tabs,
each with first/second/Back history, clean Chrome close and relaunch with
`--restore-last-session`. Both histories survived, but every target/context ID
changed and page ordering changed. CDP target inventory provided no persistent
workspace identity. This fails the ownership gate even on clean shutdown;
crash/reboot behavior cannot make that mapping safe. No production native restore
or URL/title/order matching will be added.

The first experiment used `page.goBack()`'s default load wait and failed with
`Timeout 30000ms exceeded` despite reporting navigation to `/first` (BFCache).
Using `waitUntil:'commit'` completed the experiment. This is a fixture wait issue,
not evidence that Back failed.

## Chosen fix
Ship the plan's explicit limited recovery fallback. Persist bounded host-local
HTTP(S) page hints by authorized workspace, never page content or history. On
restart keep workspace inventory. Explicit viewer recovery pauses browser work,
creates fresh runtime authority and reopens eligible saved pages in private control.
No automatic navigation from GET metadata, old controller proof, or a saved file.
Never replay an action or POST. Explain lost history/unsaved edits in the UI.
Unknown native tabs remain unassigned. Surviving Chrome singleton locks still
require explicit recovery; no arbitrary process attachment.

## Validation
Passed locally:
- `cargo build --manifest-path bud/Cargo.toml`.
- Browser unit suite: 22 passed, 3 ignored; env-gated live tests in that run
  returned early, so live evidence is recorded separately below.
- `BUD_BROWSER_EXECUTABLE=... cargo test --manifest-path bud/Cargo.toml --lib
  browser::adapter::workspace_tests -- --ignored --test-threads=1`: both live
  fixtures passed, including duplicate URLs, owner isolation and recovery once.
- Live manager global privacy/lifecycle fixture with normal Chrome.
- Headed `--no-startup-window` disposable probe: zero initial pages, one page after
  explicit creation; no orphan startup tab. Own child closed and temp profile removed.
- Service controller: 15 tests passed; DB repository/resource/continuation: 3 passed.
- Mounted web viewer: 7 tests passed; service build and web TypeScript build passed.

Two-thread real-app restart, real-account/private takeover and crash/reboot matrix
remain manual acceptance. No real daemon/profile was stopped or edited for tests.
Native restore was rejected at the clean-exit identity gate; it was not tested or
claimed to work across crashes. Recovery does not preserve native history.


The first DB regression run (`BUD_DATA_DB_TEST=1 pnpm exec node --import tsx
--test src/browser/repository.test.ts src/browser/resource-repository.test.ts
src/browser/continuation.test.ts`, from service/) found `42703: column
"pending_until" does not exist` in the resource test's hand-built workspace table.
Production already has that column; extended the fixture to match the repository's
restart fencing query rather than adding a production migration.

The initial real-Chrome fallback fixture failed with `browser_recovery_unavailable`
after saving immediately after `Page.navigate`. That acknowledgement can precede
target URL publication. The fixture now waits for the observable committed URL;
production checkpoints capture the last observed eligible page, including a final
shutdown inventory, rather than claiming that navigation acknowledgement is load.

## User acceptance (2026-09-17)

User confirmed that the real-app recovery reopened both tabs correctly. Earlier
checks confirmed shared sign-in and login persistence. Crash/reboot and the
remaining ownership/private-control race matrix are not marked complete.
