# Debug: Phase 7c observation use and page scrolling

## Environment and evidence

macOS checkout, disposable managed Chrome and Node; no user profile changes.
See [Phase 7c](../plan/bud-owned-browser/repl-phase-7c-observation-use.md)
and [ed1 review](../review/browser-repl-ed1-review.md).
The historical scroll failed 25 seconds after observation, below the 60-second
TTL, with the same main target/document afterward. Its exact invalidation cause
was not recorded; do not infer it from a reproduction alone.

## Hypothesis and proposed fix

The facade requires an observation for page-level scrolling; the helper validates
it before dispatching wheel input. Every watched child-frame navigation retires
the snapshot even if the main document is unchanged. Snapshot replacement, expiry
and daemon reference invalidation also affect this unrelated operation.

Reproduce these paths before changing behavior, then move bounded page scrolling
ahead of element-evidence validation. Preserve target ownership, active-cell and
private-control fences, serialization and uncertain outcomes. Do not change element
or scoped-read freshness. No retry, hidden capture, or target substitution.

Freeze baseline guidance in `/tmp/bud-phase7c-baseline.json`; compare concise
candidate guidance on the same corrected runtime at 8 KiB using neutral fixtures.
Results and limitations follow below after validation.

## Reproduction and lifecycle findings

Before the fix, a disposable page containing a button, input, iframe and tall
body reproduced `{same_document:true,snapshot_cleared:true,error:"browser_stale_reference"}`:
changing the iframe's `srcdoc` retired the helper snapshot, although the main
loader/document had not changed. This is a confirmed cause, not a retrospective
explanation proven for ed1.

| Boundary | Observation effect | Page scroll after this fix |
| --- | --- | --- |
| No snapshot / 60-second TTL expires | Missing/expired element evidence | Allowed on exact live owned tab |
| New snapshot/visible DOM/scoped read | Workspace helper replaces observation | Allowed; old element handles remain stale |
| Main or child frame navigation | Engine navigation listener retires observation | Allowed on current page; observe its result |
| Ordinary read-only evaluate | No explicit invalidation | Allowed |
| Viewer screenshot | No semantic invalidation by capture itself | Allowed |
| Changed viewport fit | Daemon marks semantic references dirty | Allowed; stale elements still reject |
| Identical viewport fit | No-op | Allowed |
| Different workspace helper snapshot | Independent helper observation | No invalidation of this workspace |
| Another tab in the same workspace helper | Replaces its one current observation | Allowed on exact original live tab |
| Private takeover / stale active cell | Authority fence | Rejected; old snapshots confer no permission |
| Closed/foreign target | Missing owned target | Rejected without reopening or substituting a tab |

The facade's per-tab observation IDs are retained data, not a promise that the
workspace helper's current reference map remains valid. No per-tab helper cache
is needed to fix wheel input. The daemon still validates `cell_operation` before
and after the shared FIFO lock, with current cell/sequence/deadline and browser
privacy authority. Scroll retains the existing dirty-cell viewer refresh and
unknown-outcome semantics. A wheel ACK is not proof of final scroll position;
there is no retry or document-stability promise across navigation.

## Implementation

`repl-api.mjs` no longer sends an observation ID for page scroll. `engine.mjs`
resolves the exact page, requires an integer delta within ±10000, and dispatches
one wheel call before element snapshot validation. Click, fill, focus, geometry
and scoped reads still go through the original observation checks. Existing
legacy tool schema can still supply its required observation ID; the default
REPL no longer depends on it. This is one shared scroll implementation, not a
compatibility path. No new wire fields or browser-facing authorization surface.

`scroll.test.mjs` uses real Chrome and the actual facade/engine bridge: counts one
wheel call, observes movement, checks all invalidation boundaries above except
fit (daemon integration), and proves stale element/scoped actions still fail.
`repl_execution.rs` adds no-snapshot/post-navigation scroll, foreign/closed/private
rejection, and actual viewport fit followed by a scroll cell with one viewer
refresh. Existing cancellation, late-output withholding and no-replay tests remain.

## Guidance experiment: first candidate

Frozen baseline versus candidate on the same corrected helper/worker, default
8192-byte output budget, model `gpt-5.6-luna`, high effort, two repetitions with
alternating order, five neutral fixtures. Real provider token usage, not estimates.
Disposable Chrome only: no product service DB, user profile, actual viewer,
network-latency simulation or production system prompt. These small results do
not establish statistical significance. Some local regressions ran concurrently;
elapsed times are observations, not an isolated performance benchmark.

Added only `semantic_records`: custom elements exposing article roles, nested
records with the same author, distinct own instructions, explicitly unavailable
remaining content, and a follow-up. Existing table/form/caveat/partial fixtures
cover exact URLs, one-time mutations, retained tail evidence and loading more.

| Total across 10 tasks per catalog | Baseline | First candidate |
| --- | ---: | ---: |
| Correct tasks (including follow-up/mutation checks) | 10 | 10 |
| REPL tool calls | 24 | 22 |
| Emitted tool bytes | 46,806 | 47,944 |
| Provider input tokens, summed requests | 93,195 | 97,830 |
| Cached input tokens (subset of input) | 75,232 | 79,302 |
| Provider output tokens | 3,124 | 3,047 |
| Elapsed milliseconds, summed tasks | 94,682 | 83,102 |
| Follow-up browser operations | 1 | 4 |
| Tool failures | 0 | 0 |

Exact call review: one baseline semantic-record task queried literal `article`
and got `[]`, then fetched HTML and queried `review-record`; both candidate runs
answered from the snapshot in one cell. The other baseline repeat also needed
only one cell. On tables, the candidate selected individual names/links without
stock fields, then needed another selection (6 calls total versus 5 baseline).
Both candidate caveat follow-ups recaptured whereas only one baseline did. Thus
this candidate is **not** a general context-reduction improvement.

Decision: remove the “select ... first; evaluate when absent” ordering and added
reuse imperative; leave selection versus focused evaluate flexible. Keep the
semantic-role warning, honest coverage, silent action-refresh and actual
view/cell-budget semantics for their correctness/API value. No output budget
increase, extraction subsystem, deduplication or automatic retry. Run the narrowed
candidate again against the same frozen baseline; results follow below.

Private local artifacts (not checked in): `/tmp/bud-phase7c-baseline.json`,
`/tmp/bud-phase7c-comparison.json`, `/tmp/bud-phase7c-final-comparison.json`.
Reports contain catalogs, fixture/helper/harness hashes, cells, emitted output,
answers and provider usage. Do not copy provider payloads or page content into
normal logs. The first report's helper hash predates a diagnostic-stage-only
rename from `scroll` to existing `validate_action`; dispatch behavior is unchanged.

## Guidance experiment: narrowed candidate (retained)

Same five fixtures, model/effort, 8 KiB runtime and two repetitions, with a new
baseline sample. Candidate catalog hash:
`4568058d083526a28d3edb21155e3663df4f76a1e05bc31ecbe811fb343552d3`.
Baseline hash in both experiments:
`f16aaac36fcb3e74e69f4fa9989f2a8ba0c6e86b13d1a9b555d622f4b3f4e244`.

| Total across 10 tasks per catalog | Baseline | Narrowed candidate |
| --- | ---: | ---: |
| Correct tasks (including follow-up/mutation checks) | 10 | 10 |
| REPL tool calls | 22 | 23 |
| Emitted tool bytes | 48,011 | 51,537 |
| Provider input tokens, summed requests | 91,372 | 97,158 |
| Cached input tokens (subset of input) | 74,854 | 77,854 |
| Provider output tokens | 2,805 | 3,065 |
| Elapsed milliseconds, summed tasks | 95,368 | 89,017 |
| Follow-up browser operations | 5 | 4 |
| Tool failures | 0 | 0 |

Calls by fixture, baseline → candidate: table 5→5, form 5→4, semantic records
2→4, caveat 6→6, partial 4→4. Semantic-record candidate runs split tab metadata
and snapshot into separate cells; neither catalog made the empty literal-tag
query in this second experiment. Both preserved nested attribution and explicitly
incomplete coverage. Both loaded the partial fixture and saved the form exactly
once. Both candidate caveat follow-ups still recaptured; no guaranteed reuse
improvement. No failures or exhausted call limits in either experiment.

**Conclusion:** 40/40 task chains across both experiments were correct, but there
is no demonstrated overall context reduction. The narrowed candidate used 6.3%
more summed input tokens and 7.3% more emitted bytes than its paired baseline.
Do not advertise faster or lower-context browsing from these results.

Retained guidance has a specific correctness/API purpose: semantic roles cannot
justify literal tag selectors; selection/truncation cannot justify complete-page
claims; maxBytes cannot enlarge the cell budget; refreshing action evidence need
not emit it; wheel input now has no snapshot dependency. Retained selection and
focused evaluate are alternatives, not an ordered mandatory recipe. The
stronger reuse/selection-first wording was removed. Duplicate previews remain
a measured follow-up for product acceptance, not a solved deduplication feature.

## Validation and rollout

Commands ran with `BUD_BROWSER_EXECUTABLE` set to the disposable Chrome for Testing
installation, `BUD_BROWSER_NODE` to the installed Node 24 binary, and
`BUD_BROWSER_HELPER` to this checkout's `bud/browser-helper/main.mjs` for Rust tests.
No persistent Bud browser/profile or running service was restarted.

- `node --test bud/browser-helper/*.test.mjs`: **61 passed, none skipped**.
  After adding an exact wheel-dispatch count and using the existing diagnostic
  stage, `node --test bud/browser-helper/scroll.test.mjs`: **1 passed**.
- From `bud/`, `cargo test repl_execution -- --test-threads=1`: **16 passed**,
  including actual Chrome selective/interaction/private-return cases and worker
  cancellation/disconnect/takeover/output-withholding regressions.
- After adding actual fit/one-refresh assertions,
  `cargo test live_interactions_tab_lifetime -- --test-threads=1`: **1 passed**.
- `cargo test live_repl -- --test-threads=1`: **2 passed**, including positioned
  input/geometry through the guarded bridge.
- `cargo test live_operation_media_idles -- --test-threads=1`: **1 passed**;
  existing viewer socket survives agent work and returns refreshed pixels, idle
  heartbeats do not capture, identical fits do not refresh.
- From `service/`, `pnpm build`: passed. `rustfmt` applied to the changed Rust test
  file; `git diff --check` passed. No new dependencies/schema/migrations.

Provider comparison command (run from `service/`, same executable/Node variables):

```sh
BUD_BROWSER_LIVE_MODEL=gpt-5.6-luna \
BUD_BROWSER_COMPARISON_EFFORT=high \
BUD_BROWSER_COMPARISON_REPEATS=2 \
BUD_BROWSER_COMPARISON_FIXTURES=semantic_records,table,form,caveat,partial \
pnpm exec tsx scripts/compare-browser-repl.ts \
  /tmp/bud-phase7c-final-comparison.json /tmp/bud-phase7c-baseline.json
```

To install: drain active browser cells, rebuild daemon, prepare its matching
browser helper, update service guidance and restart affected workers. No new
mobile/web release or migration. Existing element/authority checks remain;
there is no changed permission grant or automatic replay. This task has not
installed/restarted production or development services or committed changes.

**Remaining acceptance:** review a fresh product thread using the prepared helper
and updated service. Check stale-scroll recovery, semantic-role query behavior,
entity attribution, repeated observations, coverage and actual provider context.
The controlled provider experiment does not exercise durable service handoff,
real viewer latency or the complete production prompt/history. Phase 8 remains
the final merge gate.
