# Browser REPL Phase 4: output controls and comparison

## Environment and scope

macOS development checkout, managed Node 24.21.0 and disposable system Chrome.
[Implementation plan](../plan/bud-owned-browser/repl-implementation.md).
No production deployment, real-user profile changes, database migration, or
history thinning is part of these changes.

## Observed

Live thread 69229029 retained large observations locally but emitted three broad
outputs that accounted for most subsequent context growth. The worker truncated
UTF-8 safely but could cut a JSON value in half. `visibleDom()` shape and reference
replacement were unclear in the model-facing description.

## Implementation

- 8 KiB shared default for writes/console per cell; 32 KiB hard ceiling.
- `repl.setOutputBudget(bytes)` sets only the current cell's budget, before its
  first output. An API method avoids adding a second budget protocol across tiers.
- Keep complete writes preceding overflow; omit the overflowing and subsequent
  writes. `truncated:true` and the existing `output_artifact` communicate omitted
  output. No execution failure or automatic cell replay.
- Retained observations remain bounded at 2 MiB. Captured-output artifacts retain
  up to 1 MiB with an explicit truncation flag; incomplete artifacts must not be
  treated as complete JSON. Cached variables are the preferred recovery source.
- Guidance documents both observation objects' `nodes`, coverage, hierarchical
  relationships, targeted verification and stale action handles, without site rules.

## Validation

Worker tests: 13 passed on managed Node. Tests cover whole JSON emission,
shared console budget, Unicode, bounded expansion/reset, invalid/late budget
changes, artifact recall without action replay, and coverage/exact-URL preservation.

Deterministic serialization measurements (not provider tokens):

| Page shape | Full capture bytes | Selected evidence bytes |
| --- | ---: | ---: |
| Search | 44,172 | 421 |
| Table | 43,692 | 1,143 |
| Form | 44,412 | 423 |
| Article | 44,892 | 427 |
| Dynamic partial capture | 44,326 | 456 |

Real-provider comparison is recorded separately below after execution. The harness
uses fresh disposable Chrome and worker state per run, actual semantic snapshots,
identical tasks and model/reasoning budgets, alternating catalog order, and reports
provider input/output/cache tokens, peak input, calls, bytes, duration, correctness
and all tool failures. It excludes daemon authority/receipts, viewer and network
transport; it cannot replace the pending physical-device acceptance checks.

Initial harness launch accidentally used repo-root `pnpm exec tsx`; it failed
with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "tsx" not found`. Re-ran from
`service/`, where the package-local dependency resolves. No source fix needed.

## Activation

Build the daemon, prepare its matching embedded helper, then restart it before
using the new API guidance. Drain active cells first; a daemon restart loses REPL
bindings. Service tool-description changes require service reload. No iOS build,
viewer bridge change or database migration is needed. Do not mix the new prompt
with a stale prepared worker. Coordinated production catalog cutover remains
subject to the plan's comparison and lifecycle acceptance gates.

Standalone harness type-check initially omitted the project's strict setting:
`pnpm exec tsc --noEmit --target ES2022 --module nodenext --moduleResolution nodenext --skipLibCheck --esModuleInterop scripts/compare-browser-repl.ts`.
It produced TS2339 on `code`/`message` discriminants in `local-llm-data-plane.ts`
and `data-plane-router.ts`, plus TS2345/TS2322 for optional error properties.
The normal service `tsc --noEmit` passed. Rechecking the harness with `--strict`
uses the project's narrowing/schema inference semantics; no unrelated transport
code change is warranted.

The first measurement pass found an ambiguous benchmark answer schema: stock was
returned as a numeric string, semantically correct but rejected by the exact JSON
scorer. The task now explicitly requests numbers and comparison ignores object
key ordering. The next pass exposed unsupported navigation in the test harness,
which initially used `setContent` on about:blank. The final harness serves all
requests from local route fixtures, starts at a stable fixture URL, and supports
opening/navigating to detail pages through both catalogs. These early runs are
exploratory and are not used as final comparative acceptance data.

Additional checks passed:

- 29 helper/Chrome tests: managed Node `--test` over `repl-worker.test.mjs`,
  `engine.test.mjs`, and `click-point.test.mjs`, with `BUD_BROWSER_EXECUTABLE` set.
- 16 daemon tests: `cargo test --manifest-path bud/Cargo.toml --lib repl_execution -- --test-threads=1`,
  with managed Node and disposable Chrome executable overrides.
- 16 service tests, no skips: from `service/`, `BUD_DATA_DB_TEST=1 pnpm exec node
  --import tsx --test src/browser/repl.test.ts src/browser/image-artifacts.test.ts
  src/browser/image-references.test.ts src/agent/browser-tools.test.ts
  src/browser/continuation.test.ts`.
- Service `pnpm exec tsc --noEmit` and the standalone harness strict type-check.
- `cargo build --manifest-path bud/Cargo.toml`; matching add-on preparation with
  `./bud/target/debug/bud browser prepare --no-restart`; Chrome launch probe passed.
  Prepared archive: `sha256-5e935237beb6733a4cc9acd98ef120713aaf6bbd0a46537ebbe916c85450b73a`.
  No daemon/service restart or production deployment was performed.

## Final controlled provider comparison

Command, from `service/` (September 23, 2026):

```sh
BUD_BROWSER_NODE=/Users/adam/.bud/browser/node/v24.21.0/node-v24.21.0-darwin-arm64/bin/node \
BUD_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
pnpm exec tsx scripts/compare-browser-repl.ts /tmp/bud-browser-phase4-measured.json
```

Model `gpt-5.6-luna`, low reasoning, 3,000 output tokens per provider call,
12-provider-call task cap, three fresh runs per task/catalog with alternating
order. Same task, fixture and configuration within each pair. Reports retain
helper hashes, catalogs, fixtures, generated code, every output/error and actual
provider usage. No compaction or transcript thinning. Raw report is local at the
explicit path above; the durable aggregate is below.

**All 18 final tasks passed**, including exact URLs and exactly one Save per form.
Values below are independent medians across three runs. Input is cumulative
provider input across calls (including repeated context); peak is the largest
single provider input. Neither is a byte-based estimate.

| Task | Catalog | Input tokens | Peak input | Provider / tool calls | Duration |
| --- | --- | ---: | ---: | --- | ---: |
| Table lookup | Old tools | 11,074 | 9,179 | 3 / 2 | 4.30 s |
| Table lookup | REPL | 8,613 | 2,421 | 5 / 4 | 9.74 s |
| Article lookup | Old tools | 7,949 | 6,069 | 3 / 2 | 4.76 s |
| Article lookup | REPL | 3,341 | 2,055 | 2 / 1 | 3.41 s |
| Form change | Old tools | 7,728 | 1,757 | 6 / 5 | 12.12 s |
| Form change | REPL | 6,215 | 1,943 | 4 / 3 | 7.36 s |

| Task | Catalog | Tool-result bytes | Provider output tokens | Cached input tokens |
| --- | --- | ---: | ---: | ---: |
| Table lookup | Old tools | 21,973 | 147 | 0 |
| Table lookup | REPL | 2,545 | 394 | 7,468 |
| Article lookup | Old tools | 27,066 | 117 | 0 |
| Article lookup | REPL | 3,716 | 120 | 2,566 |
| Form change | Old tools | 1,350 | 357 | 4,096 |
| Form change | REPL | 1,752 | 295 | 5,631 |

Failures/recovery and variability:

- One REPL form run had a generated-JavaScript syntax error before actions; it
  corrected the code and saved once. One old-tools form run used a mistyped
  reference, received `browser_stale_reference`, refreshed and saved once.
- One REPL article run used an overly broad regex, overflowed three times, then
  deliberately expanded to 32 KiB. It emitted 29,182 result bytes and reached
  7,245 peak input tokens—worse than old tools on that run. Other article runs
  emitted 3,716 result bytes. The smaller default is not a guarantee of efficiency.
- Table tasks retain a latency/call-count cost despite much smaller peak context.
  No claim that REPL is uniformly faster or lowers every task's peak context.
- The form fixture is already tiny: REPL API/code overhead can outweigh text
  savings, although it used fewer calls and less cumulative input at the median.
- Fixtures use direct provider + real helper/worker, not the full Bud system
  prompt, service envelopes, receipt DB or network/viewer transport. This isolates
  API/output behavior and includes generated code/errors, but is not a prediction
  of absolute live-thread token counts. Only one model/reasoning setting was tested.

## Decision and remaining Phase 4 work

Keep the 8 KiB development default with explicit 32 KiB expansion. It bounds
accidental dumps while retaining local coverage; tests and varied fixture tasks
show useful small extractions, and the measured outlier is recorded rather than
hidden. Guidance explains flat pre-order hierarchy and exact artifact paths.
Do not add site-specific filtering, automatic action retries or a compactor.

**Phase 4 is not fully complete.** Keep the existing comparison catalog until
remaining lifecycle acceptance in the plan is verified: actual web/physical iPhone
private takeover/Return, cancellation, reconnect and restart against this REPL
build. Production catalog removal is deliberately pending that gate. The final
cutover should remove old executable schemas/dispatch and the comparison switch,
retain historical replay, and use a frozen benchmark-only baseline if comparison
remains useful. Nothing in this change deploys or activates production REPL.

Next acceptance should also watch table extraction call count and unnecessary
budget expansion on an actual-agent run. Historical context thinning remains a
separate, unimplemented follow-up.
