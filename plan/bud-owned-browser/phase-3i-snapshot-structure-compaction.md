# Phase 3i: reduce snapshot structure and reference overhead

Status: implemented locally; 12 automated helper/Chrome tests pass. Actual-agent acceptance pending. 2026-09-16.

## Context

Follow-up to [Phase 3f](phase-3f-compact-browser-observations.md) and the
[8/32 KiB comparison](../../debug/browser-observation-budget-32k.md).
Related spec: [browser helper](../../bud/browser-helper/browser-helper.spec.md).

The complete recorded HN snapshot contains 519 lines and 20,570 UTF-8 text bytes:
7,867 bytes of reference annotations (330 references), 5,440 bytes of indentation,
and 7,263 bytes of everything else. These are text-byte proportions, not tokenizer
proportions. The 8 KiB limit covers serialized observation JSON, including escaping
and metadata; the first small HN snapshot therefore contains only 7,341 text bytes
and roughly ten stories. This is representation overhead, not evidence that ten
story titles require that much context.

The current compact normalizer retains every table and row, including empty rows,
and gives each a scoping reference. HN uses nested tables for page layout. The
serializer then emits two spaces per depth and a repeated observation namespace
in each reference. Enlarging the budget does not fix this overhead.

## Objective

Make the existing observations denser without losing page evidence, useful scoping,
or reliable interactions. Initial implementation retained 8 KiB observations and
the 12 KiB service envelope for measurement. After actual-agent comparison, the
selected default is 32 KiB observations / 36 KiB service envelope; see the
[budget decision](../../debug/browser-observation-budget-32k.md).
Reduce total bytes and model tokens across complete observations, not merely the
first page. Preserve the five tools and one retained snapshot.

## Recommended approach

### 1. Normalize structure once, before pagination

Extend `compactNodes` rather than introducing another extractor or post-processing
results in the service. Keep the sanitized tree as the source of truth.

- Prune empty, stateless, noninteractive structural leaves such as spacer rows.
  An empty cell inside a real data row must remain: its position can matter.
- Promote children of confidently presentational wrappers, retaining reading order.
  Preserve names, states, actionable descendants and meaningful group boundaries.
- Preserve real data-table rows/cells/headers, lists and ranks, landmarks, headings,
  forms, named groups, dialogs and unnamed controls.
- Do not guess that every unnamed table is layout. First verify whether the pinned
  Playwright snapshot exposes reliable presentation semantics. If it does not,
  preserve ambiguous table relationships and remove only provably redundant
  wrappers (for example a stateless sole-child container chain without row/column
  meaning). Do not introduce site-specific classifiers to meet a size target.
- Avoid redundant reference annotations on spacer rows and layout-only containers.
  Retain useful scopes: document/main/landmarks, real tables/lists and meaningful
  groups or rows. Keep actionable references, including unnamed controls.

A small bounded bottom-up analysis of the existing tree is sufficient if descendant
information is needed. Do not query the browser once per node. Pagination and
ancestor context must operate on the resulting normalized tree.

### 2. Compact rendering and reference labels

Use one space per retained depth for snapshot text. Preserve hierarchy; do not
flatten unrelated controls into an unstructured list or concatenate story metadata
with bespoke HN formatting. Remove fixed annotation overhead where safe, e.g.
`[ref=<opaque-reference>]` can become `[<opaque-reference>]`, with tests and a concise
tool-description clarification if required. Preserve role names and named states.

Keep references observation-qualified and exact-map-resolved. `Engine.current`
currently permits omitted observation_id; therefore bare aliases reused as `e1`
on each snapshot would weaken stale-reference protection. Do not make that change.
Keep the existing helper-lifetime random namespace plus monotonic observation
counter unless a separately proven, equally safe shorter encoding is demonstrated.
The primary reference savings should come from avoiding unnecessary annotations,
not reducing identity entropy or adding a second alias registry.

Keep the existing reference-to-Playwright locator/frame map. Do not reconstruct
selectors, guess current nodes, or automatically retry mutations. Scope and visible
DOM must use the same identity mapping. No opaque-reference splitting in clients.

### 3. Keep output limits and freshness unchanged

Budget actual serialized UTF-8 JSON including metadata, escapes and continuation
ancestor context. Every continuation advances and recovers all retained semantic
content. A single oversized node remains an explicit limit error; never skip it.
Keep snapshot TTL, memory/depth limits, target/document/control fences, field-value
exclusion and private-control isolation. Scoped reads still replace the snapshot.
Visible DOM retains geometry and actionable identity; text indentation changes do
not apply to its node representation. No history rewriting or screenshot changes.

## Implementation and cleanup

1. Capture deterministic baseline fixtures and measurements before changing the
   serializer. Use HN-like layout tables plus genuine data-table and form fixtures.
2. Implement narrowly scoped normalization and rendering in `compact.mjs`; touch
   `engine.mjs` only if necessary to retain proven presentation metadata or identity.
3. Audit service/daemon/client consumers for reference parsing or text-format
   assumptions. Update only actual dependencies and tests. Replace superseded
   normalization rules rather than stacking competing compaction passes.
4. Run semantic/action regressions, measure complete output and repeat actual-agent
   tasks. Record outcomes and update the phase status; do not equate smaller output
   with adequate reading coverage.

## Acceptance and validation

- Record complete snapshot JSON bytes, text bytes, same-tokenizer token estimates,
  reference count, page count, normalization time and retained memory before/after.
- Initial target: at least 40% fewer complete HN-fixture observation bytes with no
  lost story titles/ranks/action links and fewer continuation pages. Aim to fit all
  30 stories in 8 KiB, but do not discard semantics to force that result. Record
  actual fit rather than claiming it before measurement.
- Preserve first/last stories, metadata, duplicate names, unnamed links/buttons,
  nested lists, real tables with blank cells and headers, forms and named regions.
- Test Unicode, escaped text, maximum nesting, empty pages, large nodes and cursor
  boundaries; continuation ancestors retain relationships without endless repeats.
- References still click/fill/focus the intended node and scope the intended group.
  Old references fail after refresh, navigation/Back, target switch, helper restart
  and takeover, including calls omitting observation_id. Retain iframe regressions.
- Visible DOM boxes/states and privacy exclusions remain unchanged.
- Actual agent selects HN stories 3, 16 and 30, verifies destinations, and performs
  a separate deeper-reading task using continuations where needed. Compare calls,
  cumulative/peak input, coverage and duration, with dynamic-site caveats.
- Tests use public synthetic fixtures; no production/private page dumps checked in.

## Ownership and impacted contracts

Existing owner → Bud → thread → browser-session authority remains unchanged.
Acting identity comes from the invocation; service and daemon authorize before
observation and action. No new route, stream, DB row or user-stamping path.

Impacted: human/model-readable compact snapshot text and reference presentation;
possibly helper-internal normalization metadata. Existing opaque reference strings,
request fields, response fields and error semantics should remain compatible.
No DB migration, SSE change, media change or mobile feature is intended.

## Rollout and spec updates

Prefer implementation entirely within the negotiated compact-observation helper
path, leaving legacy serialization intact. New service/old daemon continues existing
compact output; old service/new helper transports the same result fields and opaque
references; both new get denser output. Verify this against actual consumers. If an
incompatible field or required argument is unavoidable, capability-gate it before
sending it; do not silently reinterpret old references or add an unknown enum.

Restart the helper/daemon to load the implementation. Existing transcript payloads
remain immutable. Service changes should be unnecessary except narrowly justified
description/validation changes found during the consumer audit.

Docs during implementation:
- `bud/browser-helper/browser-helper.spec.md`: normalization/rendering contract.
- `docs/proto.md`: clarify compact text/reference presentation if documented there.
- Daemon browser and service agent specs only if their contracts/code change.
- This phase and the measured comparison note; link acceptance in the roadmap.

## Explicit won't-dos

No larger budget, new observation modes, verbosity settings, HN-specific extractor,
article summarizer, DOM diff/cache, history eviction, bare reference aliases,
required observation_id migration, second semantic engine, browser REPL, automatic
pagination, action retries, viewer/media work, or controller-lifecycle refactor.


## Implementation results

See [validation and measurements](../../debug/browser-snapshot-structure-compaction.md).
Implementation is confined to the existing compact serializer and its tests.
Playwright supplies no reliable layout-table marker here, so ambiguous table
structure remains. Empty row leaves and redundant sole-child table wrappers are
removed; references retain existing identities with shorter bracket labels, and
indentation uses one space per depth. Legacy output and reference resolution are
unchanged. No new service, transport, provider or client behavior is required.

The fuller nested fixture falls from 18,868 to 13,380 bytes (29.1%), from 5,288 to
4,497 o200k_base tokens (15.0%), and from three observation pages to two. The 40%
initial target and single-page aspiration were not met; no semantics were removed
to force them. Normalization averaged 0.152 ms for this fixture. Existing simpler
fixture falls from 7,484 to 6,266 bytes. All automated action/coverage regressions
pass. Real-agent task-wide comparisons and deeper-reading acceptance remain to run
after helper/daemon restart; no service restart or database migration required.
