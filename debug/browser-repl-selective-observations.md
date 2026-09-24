# Debug and validation: REPL selective observations (Phase 2)

## Environment and objective

macOS development checkout, managed Node 24.21.0, pinned Playwright helper,
Rust daemon and Node service. Implements Phase 2 of
[the implementation plan](../plan/bud-owned-browser/repl-implementation.md).
Browser operations retain existing owner/workspace/epoch and invocation checks.
No new database table, browser-facing route, permission workflow or scheduler.

## Observations and approach

The Phase 1 worker already separates cell execution from the page lock. Phase 2
adds a typed facade over that bridge. Full structured snapshots stay local (2 MiB
node ceiling); only explicit output reaches transcripts. Frame evaluation is
potentially mutating and never retried. Viewer refresh coalesces at cell completion.

Image upload uses two service-issued single-use capture tickets, outside model
arguments and saved source receipts. Unsupported/text-only models receive no
upload tickets. Delivery checks still withhold all content after takeover.

Worker artifacts use a private temporary directory removed with that worker, at
most 16 files of 1 MiB with oldest-first eviction. Output beyond 32 KiB is captured
up to 1 MiB and referenced, not injected into model context. Heap reset also loses
these files; normal takeover retains both. This is trusted host execution, not a
filesystem sandbox against deliberately bypassing the helpers.

## Validation findings

Initial command `python /tmp/phase2-edit.py` failed with `command not found: python`;
rerunning with `python3` succeeded. No repository changes occurred before that retry.

Initial focused service test command:
`BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test src/browser/repl.test.ts src/browser/image-references.test.ts src/browser/image-artifacts.test.ts src/agent/browser-tools.test.ts`
reported two catalog/replay failures: the new executable name was absent from the
stored-directive switch, and the old-family encoding assertion incorrectly used
the union of old and new tool names. Fix the replay path and test both catalog
selections independently. These are Phase 2 integration failures, not ignored
pre-existing failures.

## Rollout / experiment

Use matching service, rebuilt daemon and prepared browser helper. The temporary
non-production default selects only `browser_exec` plus the existing handoff tool.
`BUD_BROWSER_TOOL_MODE=repl` is optional; set it to `tools` for the old family. Daemons must advertise
`browser.repl:true`; unsupported peers never receive a cell. Do not run both tool
families in one provider request. No web/mobile rebuild or migration is required.

Validation results and live acceptance are recorded below as completed.


## Results

- Managed Node `--test bud/browser-helper/repl-worker.test.mjs`: 10 passed.
- Managed Node with `BUD_BROWSER_EXECUTABLE` pointing to system Chrome,
  `--test bud/browser-helper/engine.test.mjs bud/browser-helper/compact.test.mjs`:
  13 passed, none skipped; disposable headless profiles only.
- `BUD_BROWSER_NODE=<managed Node> BUD_BROWSER_EXECUTABLE=<system Chrome>
  cargo test --manifest-path bud/Cargo.toml --lib repl_execution -- --test-threads=1`:
  15 passed, including live owned-frame evaluation, >32 KiB retained snapshot,
  local-only follow-up and private-control lifetime checks.
- `BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test
  src/browser/repl.test.ts src/browser/broker.test.ts src/browser/transport.test.ts
  src/browser/image-artifacts.test.ts src/browser/image-references.test.ts
  src/agent/browser-tools.test.ts src/agent/context-budget.test.ts
  src/browser/continuation.test.ts`: 35 passed, none skipped. Isolated DB fixtures
  cover receipts and continuation; AgentService uses a scripted provider fixture.
- `pnpm --dir service exec tsc --noEmit`: passed.
- `cargo clippy --manifest-path bud/Cargo.toml --lib -- -D warnings`: passed.
- Initial `cargo fmt --manifest-path bud/Cargo.toml --check` reported formatting
  differences in the new facade dispatch. Applied rustfmt; final check passes.

At initial implementation, no live provider call or real-user handoff experiment
was run. The subsequent real-provider observation/navigation task passed in thread
`3297763e-fb32-403d-b30b-57baa1594e72`: seven successful continued-task cells,
31.3 KiB text and one image, provider input 19,017 → 33,182 tokens, then evidence
reuse in a follow-up. Actual-agent interactions and real-user handoff remain
Phase 3 acceptance; this is not a controlled old/new comparison.
No user services/daemon were restarted; no personal Chrome profile was touched.
The Phase 2 Open facade reuses existing ensure-and-navigate behavior. Additional
owned-tab creation/selection/close is part of Phase 3's interaction completion.


### Development default follow-up

REPL now defaults on outside production; `BUD_BROWSER_TOOL_MODE=tools` keeps
explicit old-family comparison. Catalog tests cover absent setting, both explicit
selections and production gating. The first TypeScript check reported
`src/agent/browser-tools.test.ts(21,5): TS2339: Property 'after' does not exist on
type 'TestContext | SuiteContext'`. Replaced per-context cleanup in `beforeEach`
with the supported `afterEach` hook and reran validation.
