# Validation: REPL interactions (Phase 3)

## Environment and scope

macOS, managed Node 24.21.0, pinned Playwright and disposable headless Chrome.
Implements [Phase 3](../plan/bud-owned-browser/repl-implementation.md).
Existing service owner/Bud/thread authorization and daemon invocation/control
fences remain authoritative. No new routes, tables or client contracts.

## Approach

The facade binds element handles to an observed snapshot, reuses exact semantic
actions and exposes explicit owned-tab create/select/close. Focus records the
actual element through the existing adapter; committed text additionally checks
the facade's target. Logical selection does not activate a native window.
Closing a tab preserves the worker; closing its workspace still destroys it.
Final-tab close explicitly clears recovery hints rather than resurrecting a page
the agent deliberately closed. Browser errors request one viewer refresh because
scrolling or an earlier mutation may have occurred; they do not reset media.

## Validation findings

Initial command: `BUD_BROWSER_NODE=<managed Node>
BUD_BROWSER_EXECUTABLE=<system Chrome> cargo test --manifest-path bud/Cargo.toml
--lib repl_execution -- --test-threads=1`.

15 tests passed; the new tab lifecycle fixture failed on immediate metadata after
closing all owned tabs and opening a blank replacement. The cell returned
`Error: browser_target_not_found` at `cell-14`. Investigation and final results
are recorded below.

Splitting the cell with an `opened` output confirmed creation succeeded and the
immediate metadata read failed. Chrome's create acknowledgement can precede
Playwright's page inventory event on its separate CDP connection. The semantic
engine now waits up to one second for inventory propagation. It does not repeat
creation, navigation or any interaction.

## Remaining acceptance

Real-agent interaction tasks and physical iPhone/web takeover, fitting,
minimized capture and reconnect over ngrok require a matching daemon/helper
restart and manual acceptance. Automated fixtures do not establish those checks.

## Final results

- Managed Node with `BUD_BROWSER_EXECUTABLE=<system Chrome>`,
  `--test bud/browser-helper/repl-worker.test.mjs
  bud/browser-helper/engine.test.mjs bud/browser-helper/click-point.test.mjs`:
  26 passed, none skipped. Includes layered links/media, frames and click geometry.
- The daemon `repl_execution` command above: 16 passed, none skipped. The public
  interaction facade now exercises private Return, memory retention and stale
  handles in addition to worker interruption/receipt-lifetime regressions.
- Same daemon environment, `cargo test --manifest-path bud/Cargo.toml --lib
  live_private -- --test-threads=1`: two passed; private capture/input/stale-frame
  and email-field text guards remain functional.
- `BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test
  src/agent/browser-tools.test.ts src/browser/repl.test.ts`: 11 passed, none
  skipped. Includes the isolated database receipt test. The initial run without
  the opt-in flag passed 10 and skipped that fixture; the opt-in rerun passed it.
- `pnpm --dir service exec tsc --noEmit`,
  `cargo clippy --manifest-path bud/Cargo.toml --lib -- -D warnings`,
  `cargo fmt --manifest-path bud/Cargo.toml --check`, and `git diff --check`: passed.

No live provider task, native minimized-window test or physical-device test was
performed in this implementation pass. User processes were not restarted.
To activate, rebuild/restart the daemon with the matching helper; extracted
installations need `bud browser prepare` after rebuilding. Checkout helper users
need the daemon restart to replace loaded modules. The service catalog changes
with its normal dev reload; no migration or mobile build is required.
