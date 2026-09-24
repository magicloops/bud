# Debug: REPL-only cutover

## Environment and reproduction
Phase 7g, macOS local checkout, coordinated pre-launch service/daemon upgrade.
The initial catalog selected old tools in production and the broker/executor kept
a second dispatch/output path. Inspect catalogs and trace their callers into the
Rust manager and helper. No production incident or deployment was performed.

## Decision
Only browser_exec and browser_request_handoff execute. The user explicitly waived
historical browser-result compatibility. Remove historical-only adapters without
deleting/reformatting stored rows or replaying old mutations.

## Caller map
- Removed: old agent schemas/catalog/mode flag/directives, broker command mapping
  and single screenshot dispatch, executor old summaries/envelope check.
- Removed: old conversation reconstruction, observe image hydration and observation
  renderer. Pane discovery uses current inventory and handoff events.
- Removed: standalone Rust capture/click/focus/insert_text wire actions, inspect
  continuation, compact_observations capability, helper continuation/text pagination.
- Kept: internal open/navigate/inspect used by repl-api.mjs, compactNodes structural
  normalization, full local captures, snapshot.format and 8 KiB emitted default.
- Kept: owner admission/receipts, control/recovery, lifecycle close, multiple REPL
  image transfers, endpoint/ticket validation and output withholding after takeover.
- Comparison harness is REPL-only; old measured reports remain historical evidence.

## Validation and failures investigated
- `pnpm --dir service build` initially reported TS2322 in conversation-loader.ts
  because retired names were still executable directives. Removed that historical
  adapter under the clarified scope; service and web builds pass.
- `cargo test browser:: --lib` initially reported E0599 for Capture in REPL image
  validation. Moved the unchanged URL/ticket policy to valid_image_upload and added
  explicit regression cases. The standalone wire action is not retained as an alias.
- The initial concurrent Rust run had two addon tests fail due to shared process
  environment/version overrides (browser_profile_in_use and Chrome version mismatch).
  `cargo test browser:: --lib -- --test-threads=1` passed 82 tests, six ignored.
- Helper: BUD_BROWSER_EXECUTABLE pointing to installed Chrome, `node --test *.test.mjs`:
  58 pass using disposable browser fixtures.
- Service focused agent/browser/context/invocation suite: 78 pass, seven database
  gates skipped. Then BUD_DATA_DB_TEST=1 broker/continuation/repl/image-artifacts:
  five tests pass, zero skips, covering the critical durable and artifact paths.
- Web `pnpm exec tsx --tsconfig tsconfig.app.json --test src/features/browser/*.test.ts
  src/features/browser/*.test.tsx`: 29 pass.

Rust live-fixture and final validation results are recorded below. Physical
headed/private web/mobile smoke checks remain Phase 8 acceptance. No commit,
restart or deployment performed. Phase 7g has no migration; the cumulative branch
still requires Phase 7f 0042. Drain old active calls before coordinated rollout.

The first live Rust command supplied BUD_BROWSER_HELPER as a directory rather
than main.mjs, causing browser_helper_output_limit/browser_not_ready and worker
startup failures. Corrected to the entrypoint file. Live fixture runs exclude
addon unit tests, whose deliberate version/override assumptions require an unset
browser environment; those pass in the separate serial unit run.

Final caller audit removed unused adapter focus/click shortcuts and their implicit
semantic_target cache. The retained click regression now uses explicit-target inspect.

## Final checks

- Corrected Chrome-backed Rust run: 64 passed, six explicitly ignored headed/manual
  fixtures (addon override tests excluded and tested separately without overrides).
- After removing unused adapter shortcuts: live table/order/stale-reference test
  passed; helper engine suite passed 9/9 with Chrome.
- Final DB-enabled broker/continuation/REPL/artifact plus catalog suite: 16/16 pass,
  zero skips. Service TypeScript build passes after broker simplification.
- Web build passes (existing bundle-size advisory only); diff whitespace check passes.
- One final Rust command was mistakenly launched at repository root and returned
  `error: could not find Cargo.toml in /Users/adam/bud or any parent directory`;
  rerun from the bud package directory, with output in the final validation log.

No old executable browser names or mode-selection code remain in application
paths; negative tests and historical design/review evidence intentionally name them.
Phase 8 retains physical smoke acceptance and workspace lifecycle policy.

Final serial Rust unit run: 84 passed, zero failed, six explicitly ignored.
