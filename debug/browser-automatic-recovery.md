# Debug: Browser restart requires manual control repair

## Environment and reproduction
macOS managed persistent Chrome, service and shared web/iOS viewer. Restart the
daemon during private browsing, then open the viewer or ask the agent to continue.

## Observed
Persisted private intent outlives Chrome. Return acquires a blank workspace and
then returns it; saved pages require a separate reopen action. Checkpoints omit
query/fragment URLs and operation/shutdown saves can include private navigation.
The current serial CDP client discards events rather than consuming navigation
changes between operations.

## Expected and approach
Follow the approved automatic recovery design: agent-visible checkpoints only,
confirmed process loss before authority reset, lazy owner-authorized ensure,
truthful continuation results and no replay of uncertain actions. Add a bounded
navigation event subscription rather than DOM or screenshot polling.

## Implementation and validation

Implemented shared lazy ensure, confirmed-runtime-loss reconciliation, v2 public
URL checkpoints and the shared web/mobile viewer lifecycle. Return validates its
transition before private inventory reads; checkpoint flush gathers all workspaces
before one atomic write. Invalid or partially failed Return cannot publish a
partial private checkpoint. Partial restore also retains skipped durable pages.

Commands (service/web commands run from their package directories):

- `cargo test --manifest-path bud/Cargo.toml browser:: --no-fail-fast`
- `BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' cargo test --manifest-path bud/Cargo.toml browser:: -- --include-ignored --test-threads=1`
- `pnpm exec tsx --test src/browser/*.test.ts`
- `BUD_DATA_DB_TEST=1 pnpm exec tsx --test src/browser/repository.test.ts src/browser/resource-repository.test.ts src/browser/continuation.test.ts`
- `BUD_DATA_DB_TEST=1 pnpm exec tsx --test src/browser/broker.test.ts src/browser/resource-repository.test.ts src/browser/mobile-auth.test.ts`
- `pnpm exec tsx --tsconfig tsconfig.app.json --test src/features/browser/viewer.test.tsx src/features/browser/mobile-viewer.test.tsx`
- Service `pnpm exec tsc --noEmit`; web `pnpm exec tsc -b`.

Initial validation corrections: web TSX without `--tsconfig tsconfig.app.json`
failed with `React is not defined`; reran using the package config. A service test
expected `browser_outcome_unknown` where ensure intentionally returns
`browser_recovery_uncertain`; updated the assertion. The mobile control allowlist
test still expected removed `reopen`; it now verifies rejection. One earlier live
capture-disconnect run failed its observation assertion; focused rerun and the
complete 56-test real-Chrome run passed. No timing threshold was weakened.
A temporary Rust edit misplaced a request reference; compilation caught it and
it was corrected before validation. A docs/test-edit helper invoked from service
with repository-relative paths raised `FileNotFoundError`; reran at repository root.
These were local validation/setup failures, not changes to the recovery contract.

Final results and manual acceptance are tracked in the
[implementation plan](../plan/bud-owned-browser/automatic-recovery-implementation.md).
