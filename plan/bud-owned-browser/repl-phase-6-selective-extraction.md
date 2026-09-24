# Phase 6: Selective extraction and efficient output recovery

Status: evaluation tooling implemented; prompt candidates evaluated and reverted.
Efficiency acceptance and supplementary live review remain open. 2026-09-23.

## Implementation outcome

The expanded harness compares saved and current REPL catalogs across eight neutral
fixtures. All 48 final runs passed correctness checks. Three guidance candidates
were evaluated; none established the required efficiency improvement. The final,
single-sentence reuse cue increased ordinary-task cumulative input by 18.8% and
added six tool calls. Existing Phase 5 guidance is restored exactly; no Phase 6
prompt change is retained. See [results](../../debug/browser-repl-phase6.md) for
per-task ranges, earlier experiments and fixture corrections.

The scope below records the hypotheses tested, not claims of shipped guidance.
No new runtime mechanism is justified by these results.

## Context

Follow-up to [Phase 5](repl-phase-5-standard-output.md) and the
[parent implementation plan](repl-implementation.md).

[Thread 4462398b](../../debug/browser-repl-446-review.md) used console/final-value
output successfully. Compared with the preceding similar live task, inline text
fell from 88,760 to 43,262 bytes and context growth from 44,675 to 20,273 tokens.
However, calls rose from 10 to 17 and duration from 53 to 84 seconds. Eight
emissions overflowed. Nested replies were duplicated, script text consumed
excerpt budgets, and truncation before retention forced another page read.
Different live content prevents treating this as a controlled comparison.

The [accessibility spike](../../debug/browser-accessibility-spike.md) found no
general size advantage from replacing Playwright with native Chrome AX. It also
exposed missing string children and toggle states, now addressed by the
[fidelity fix](../../debug/browser-snapshot-fidelity.md). Use that corrected
helper on **both sides** of Phase 6 comparisons; information loss is not savings.

Related specs: [agent](../../service/src/agent/agent.spec.md),
[helper](../../bud/browser-helper/browser-helper.spec.md),
[scripts](../../service/scripts/scripts.spec.md).

## Objective

Improve the agent's selection of evidence with fewer avoidable model round trips,
while preserving attribution, exact source identity and honest coverage.
This phase changes guidance and behavioral evaluation, not the browser runtime.

Success means correct answers supported by bounded, relevant observations;
smaller output alone is insufficient. Comprehensive tasks may legitimately need
more evidence than selective lookups.

## Reference implementation lessons

Revisited `/Users/adam/code/browser-use-pi` at
`fa838f3298673950923bdaf12bd3c1b6279cd119`:

| Source | Observed behavior | Application to Bud |
| --- | --- | --- |
| `src/prompt.ts` | Filter accessibility observations before printing; extract with ordinary JS; preserve source observations and verify identity, counts and coverage | Make these behaviors concrete in concise existing guidance |
| `src/page.ts` | AX discovery and general page evaluation; no dedicated comment extraction | Keep agent-authored extraction and the existing facade |
| `src/worker.ts` | Persistent bindings, console/final-value output, captured output files | Phase 5 already supplies the relevant interaction model |
| `src/context.ts` | Recent-image retention and later conversation checkpoints | Separate history management from this phase's initial evidence selection |

The reference does not automatically remove nested-record duplication or ensure
complete extraction. Its worker can truncate a text prefix; that is not a reason
to replace Bud's whole-emission overflow behavior. These are source observations,
not evidence that its agent performs better on our tasks. The local checkout is
inspiration, not a new runtime dependency.

## Scope and design

### 1. Refine the existing tool guidance

Edit the discovery/extraction/output sections of `service/src/agent/browser-tools.ts`.
Replace overlapping advice rather than accumulating another prompt or a lengthy
mandatory procedure. Preserve the existing API, freshness and control guidance.
Keep argument-error help consistent where relevant.

Teach these general behaviors:

- **Retain before selecting.** Store complete relevant observations within the
  existing capture limits. Apply previews at emission time, not destructively to
  the only saved copy. Scope or batch large sources; do not interpret this as
  “load the whole site into memory.” Keep raw evidence separate from derived data.
- **Establish record boundaries.** For unfamiliar or ambiguous structure, inspect
  a small structural sample, then extract records with source identity and their
  own text. Parent containers may include child records. Preserve relationships
  without emitting child text again as part of every ancestor. Do not deduplicate
  solely by equal text: separate records can have identical bodies or labels.
- **Use the observation suited to the question.** Prefer the corrected accessible
  snapshot when it already contains the needed evidence; use focused DOM
  evaluation for missing fields or relationships. When extracting DOM text,
  distinguish content from script/style/control descendants structurally. No
  site-name filters, script-string blacklists or blanket removal of meaningful
  controls from discovery. Do not change the live DOM merely to clean output.
- **Bound the evidence, not its meaning.** Emit requested fields, relevant records
  and aggregates. Preserve full URLs, parent/source identity and exceptions that
  affect the answer. A preview must remain identifiable as a preview; expand
  relevant incomplete records before making claims about their full content.
- **Avoid unnecessary turns.** Once selection is understood, combine local
  projection, size checking and bounded emission in one cell. A separate discovery
  cell is useful when the next action depends on what it finds, not a mandatory
  step for every page. Keep browser mutations awaited, bounded and verified.
- **Make coverage explicit.** Distinguish loaded records, emitted records, clipped
  fields and unavailable/unloaded content. Qualify an answer or obtain missing
  evidence as the task requires. Neither successful execution nor
  `truncated:false` proves full source coverage.

Use at most a couple of short examples, with neutral records/table/article data
and the actual Bud API. Avoid hardcoded production selectors or a universal
record schema. Agent-written helpers may be retained locally when useful; do not
add a product extraction library for them.

### 2. Clarify recovery without a new output mechanism

After overflow, the action has still completed. Select from the retained value
first. If using an artifact, assign its contents locally; parse only known complete
JSON, otherwise inspect the formatted text locally and select relevant evidence.
Do not end the cell with the entire artifact read or reprint arbitrary prefixes.
Do not repeat browser actions to recover output.

Ordinary JS can measure `Buffer.byteLength(JSON.stringify(selected), 'utf8')`
when exact JSON is appropriate. Leave space for other output in the same cell.
Choose a smaller meaningful subset or explicitly expand for relevant evidence;
do not add a new budgeting API, automatic retry loop or implicit budget increase.
Node inspection previews and capture-limit truncation remain separately documented.

### 3. Extend the existing comparison harness narrowly

Reuse `service/scripts/compare-browser-repl.ts`, disposable Chrome and existing
worker/helper paths. Allow comparison of saved baseline and candidate REPL
catalog descriptions, recording their hashes, rather than reintroducing a second
production catalog or comparing Phase 6 against old structured tools.

Keep the existing table/article/form cases. Add a small set of fixed tasks:

| Fixture/task | Correctness evidence |
| --- | --- |
| Nested records with repeated labels, children and inert script content | Correct attribution, parent IDs and own-body extraction; no descendant double counting |
| Ordered result cards with duplicate wrappers and explicit exclusion metadata | Requested ordinal after filtering distinct entities; exact query/fragment URL |
| Long document with a decisive caveat near the end, then a follow-up | Initial answer includes relevant caveat; follow-up can use retained full evidence |
| Partially loaded records with an explicit load-more control | Agent loads required evidence or accurately reports partial coverage; no invented total |
| Seeded oversized output with a retained value/artifact | Recovery selects locally without repeating a recorded mutation or emitting the whole artifact again |

Use deliberately varied but small fixtures, not copies of Reddit pages. Encode
critical facts in expected results; inspect free-form summary attribution and
coverage manually against known evidence. Test the fixture oracle itself where
needed. No tests asserting prompt vocabulary or requiring a particular sequence
of JavaScript expressions. A forced-overflow scenario evaluates recovery only;
report it separately from naturally occurring overflow rates.

## Measurement and acceptance

Freeze the corrected Phase 5 runtime, baseline prompt, fixtures, model and effort
before editing guidance. Run baseline/candidate with identical settings, alternate
order, and use three repetitions per task. Include the high reasoning setting
used in the live reviews. Keep fixtures/network isolated and save complete reports
with private permissions. Record prompt/runtime hashes and any call-limit exits.
A shared bounded call limit must allow recovery, and exhaustion counts as failure.

Record per task and repetition:

- Correctness, attribution, coverage, missing decisive evidence and duplicate actions.
- Actual provider input/output/cached usage, peak input and context growth.
- Inline output bytes, natural overflows, budget expansions and repeated broad output.
- Model/tool call counts and wall duration; distinguish tool time from total time.

Acceptance requires all deterministic fact/identity/action checks to pass and no
unqualified completeness claims for partial reads. On selective tasks, look for
repeatable reductions in avoidable emissions and recovery turns without shifting
the cost into more calls or poorer answers. Report medians, ranges and regressions
per task; do not hide correctness failures in an aggregate savings figure or set
an arbitrary token-saving percentage. If results are mixed, retain only supported
guidance changes and document the unresolved cases. Do not escalate to a generic
extractor or compaction change within this phase.

A live product run is a supplementary check after fixed-fixture validation.
The pre-existing scroll/click test failure and physical viewer/private-control
acceptance remain separate requirements before Phase 4 catalog cutover.

## Boundaries, ownership and rollout

Keep `browser_exec`, console/final-value output, explicit images, 8 KiB default,
32 KiB expansion ceiling, capture/file retention limits, Playwright observation
source and existing compaction unchanged. No new browser tool, extraction DSL,
comment API, raw CDP access, history thinning or automatic action replay.

The service still resolves the owning thread/Bud/invocation; the daemon checks
workspace authority for supported operations and output delivery. No route,
stream, DB table, owner stamping or wire envelope changes are planned. Existing
authorization and private-control requirements continue to apply.

Required runtime baseline: Phase 5 console/final-value support plus the snapshot
fidelity fix. Prepare/restart matching helpers first if that baseline is not yet
installed. Phase 6 guidance changes then require only the service update; fixtures
are developer tooling. No additional daemon/mobile/web upgrade, migration,
compatibility alias or production catalog switch is required. Rollback is a
service guidance revert, not replay of prior cells.

## Implementation checklist

- [x] Freeze baseline guidance and run expanded behavioral fixtures on corrected runtime.
- [x] Evaluate concise retention, boundary and recovery advice; retain only supported
  changes (none of the three candidates justified retention).
- [x] Compare candidate against baseline; inspect correctness and efficiency regressions.
- [x] Record results in `debug/browser-repl-phase6.md`.
- [ ] Establish a repeatable efficiency improvement without correctness or call regressions.
- [ ] Review one supplementary live product task with the corrected snapshot helper.
- [x] Update [agent spec](../../service/src/agent/agent.spec.md) and
  [scripts spec](../../service/scripts/scripts.spec.md) for evaluation tooling and outcome.
- [x] Update parent plan status from measured evidence; retain outstanding Phase 4 gates.

No service/daemon restart, commit or deployment was performed for this evaluation.
