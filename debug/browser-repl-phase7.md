# Debug: Native click actionability (Phase 7)

## Environment and reproduction

macOS, managed Node 24.21.0, playwright-core 1.63.0, pinned Chrome for Testing
build 1234. Fixtures launch disposable headless profiles, never the live Bud
profile. Related: [plan](../plan/bud-owned-browser/repl-phase-7-actionability.md),
[design](../design/browser-actionability-and-targeting.md),
[trace review](../review/browser-repl-f44-trace-review.md).

## Observed baseline

A neutral `<details role="article">` with an unnamed pointer-cursor summary and
nested profile link reproduces the gap. Upstream `ariaSnapshotJSON({mode:'ai'})`
returns the article, a generic header with `cursor:"pointer"` and a real `ref`,
and the nested link. Bud's sanitizer discards cursor; compact output also drops
the unnamed wrapper/reference. `selectClickPoint(article)` rejects with
`browser_click_blocked`. A normal Playwright click on the upstream header ref
opens the disclosure; the profile link receives zero clicks.

## Decision and proposed fix

Preserve the upstream hint and reference; no new discovery API is needed.
Use a single native Playwright click invocation on the uniquely resolved element.
Retire the mandatory random/grid sampler. Covered layered cards require explicit
positioning: add `element.geometry()` (current CSS padding-box width/height) and
`element.click({position:{x,y}})`, with strict finite/in-bounds validation and the
same observation/target/authority checks. Geometry is evidence, not a guarantee
of hit-test success. Never force, substitute another element, or replay a click.
Native action failures remain uncertain and do not reset a healthy runtime.

## Validation

Implementation checks and outstanding live acceptance are recorded below.

Initial focused run: 28/31 passed; three existing compact-reference tests failed
with `browser_stale_reference` because their reference parser consumed the new
`[cursor=pointer]` preceding `[reference]`. Kept the existing reference position
and appended the hint instead. `cargo check -q` passed.

The broader Rust run initially passed 72 tests but failed
`live_table_observation_reads_story_links_in_order` (viewer_tests.rs:474): the
first bounded legacy snapshot contained Story 1–29 rather than all 30 plus Footer.
Pointer metadata moved the byte boundary. Updated the regression to consume its
frozen continuations, asserting cursor progress and retaining all ordering,
privacy and click/stale-reference checks. No observation limit was increased.

The initial actual-agent harness exposed raw Playwright errors, unlike the product
helper's canonical `browser_outcome_unknown`. Corrected that harness boundary and
reran the fixtures; initial results are not the final acceptance evidence.

## Final automated checks

Commands below run from the indicated package directory. Runtime variables for
Chrome checks point at the pinned Chrome for Testing executable and managed
Node 24.21.0; `BUD_BROWSER_HELPER` points to the checkout's `main.mjs`.

- Helper: `node --test '*.test.mjs'` with managed Node and
  `BUD_BROWSER_EXECUTABLE`: **53 passed, zero skipped**. Native/custom disclosure
  full JSON adds 19 UTF-8 bytes; compact nodes add 67 bytes because the previously
  removed unnamed control/reference now survives. Scoped and visible formats
  retain the same actionable hint. Layered-card default/covered-title attempts
  generate zero post/media events; one explicitly positioned card click generates
  one post event and zero media events.
- Daemon: `cargo test browser:: -- --test-threads=1`: 72 passed, one table-fixture
  failure described above, six explicitly ignored environment/manual tests.
  After fixing the test's continuation handling, its targeted rerun passed.
  Added `cargo test live_repl_position_and_geometry_use_the_guarded_bridge --
  --test-threads=1`: passed. **74 distinct passing browser tests in total**;
  the six existing ignored tests were not run. Includes live Chrome authority,
  takeover/Return, cancellation, duplicate delivery, uncertain click preservation
  and real worker geometry/position/out-of-bounds/binding preservation.
- Service: `pnpm exec tsx --test src/agent/browser-tools.test.ts
  src/agent/browser-observation-budget.test.ts src/browser/repository.test.ts
  src/browser/repl.test.ts`: 12 passed, two DB tests initially skipped.
  `BUD_DATA_DB_TEST=1 pnpm exec tsx --test src/browser/repository.test.ts
  src/browser/repl.test.ts`: both passed using isolated local schemas.
- `cargo check -q`, `pnpm build` in service, and `git diff --check`: passed.

No live daemon, service or prepared installed helper was restarted or replaced.
No commit, deploy or PR update. Matching build/prepare/restart remains necessary
before the supplementary live product run. Existing Phase 4 physical viewer and
catalog cutover, and Phase 6 efficiency gates remain independent.

## Actual-agent fixtures

Ran from `service/` using the configured default `gpt-5.6-luna`, low reasoning,
managed Node/Chrome and the current catalog. The harness's baseline/candidate
slots deliberately used the **same** current catalog as two repetitions; this
is acceptance sampling, not an old/new performance comparison.

```sh
BUD_BROWSER_COMPARISON_REPEATS=1 \
BUD_BROWSER_COMPARISON_FIXTURES=disclosure,layered \
pnpm exec tsx scripts/compare-browser-repl.ts \
  /tmp/bud-phase7-agent-canonical.json /tmp/phase7-catalog.json
```

`BUD_BROWSER_NODE` and `BUD_BROWSER_EXECUTABLE` were set as above. The final report
contains exact source/results, runtime/catalog hashes and provider usage; raw
Playwright errors are mapped to the same canonical code as the product helper.

| Fixture/run | Correct + effect check | Tool calls | Duration | Failed calls | Emitted bytes | Peak input tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Disclosure 1 | yes | 3 | 10.7 s | 0 | 1,377 | 2,057 |
| Disclosure 2 | yes | 3 | 8.0 s | 0 | 1,370 | 1,925 |
| Layered card 1 | yes | 12 | 50.2 s | 2 | 4,065 | 4,210 |
| Layered card 2 | yes | 12 | 48.9 s | 3 | 4,499 | 4,433 |

Disclosure runs selected the actual observed header, expanded it and observed
HERON-27; profile click count stayed zero. Both layered runs obtained geometry,
ultimately clicked the exposed (10,10) point of the observed card link, verified
IBIS-16, recorded one post event and zero preview events. Neither bypassed the
click API or silently substituted the covered same-URL title.

Limit: layered-card reasoning is still inefficient. After verifying unchanged
state, agents repeated blocked default clicks; one explicitly retried the covered
center before choosing an exposed corner. Native actionability prevented wrong
input and the workspace remained usable, but this is not evidence of efficient
first-try selection. No site-specific prompt, fallback navigation, force option,
or hidden point-search algorithm was added to make the fixture pass.

Supplementary real-site/web/mobile acceptance remains pending a coordinated
build/prepare/restart. The deterministic fixtures and isolated actual-provider
runs do not test the deployed viewer transport or physical takeover UI.
