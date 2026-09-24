# Phase 7b: Compact snapshot output and useful overflow recovery

Status: implemented and controlled comparison evaluated; retain 8 KiB with explicit
expansion. Supplementary live review completed with follow-ups. 2026-09-24.

Budget update (2026-09-24): after the live 16 KiB experiment, the user requested
restoring the **8 KiB default**. Worker output, standalone snapshot-view fallback
and service guidance agree on 8,192 bytes; explicit per-cell expansion remains
capped at 32 KiB. The historical fixture results below and live reviews remain
unchanged. See [1af](../../review/browser-repl-1af-review.md) and
[the same-post rerun](../../review/browser-repl-5c1-review.md) for the tradeoffs
and comparison caveats.

Validation covers exactly 8,192 bytes fitting, 12,000-byte output overflowing,
reset after explicit expansion, UTF-8, artifacts and shared snapshot/console space.
Rebuild and restart the daemon to load the embedded helper (managed installs
upgrade automatically on startup); reload service guidance as well. Existing
workers retain their loaded code until restart. No migration or viewer build.
Implementation/validation: [Phase 7b record](../../debug/browser-repl-phase7b.md).
Runs after the Phase 7 actionability work and before
[Phase 8 final merge acceptance](repl-phase-8-workspace-lifecycle.md).
Parent: [REPL implementation plan](repl-implementation.md).

## Context and evidence

The [01ce review](../../review/browser-repl-01ce-review.md) found seven output
overflows and 15 browser cells in a 69-second task. One recovery read and printed
an entire oversized artifact, overflowing again. The final 19 comment bodies fit
in 5,350 bytes. The [07a review](../../review/browser-repl-07a-review.md) also found
repeated overflow and expensive structural discovery.

A follow-up breakdown of 01ce cell 5's 27,647-byte formatted projection shows:

| Content | UTF-8 bytes |
| --- | ---: |
| URL values | 12,754 |
| Element reference values | 5,482 |
| Names and text values | 2,784 |
| Remaining fields, syntax and formatting | 6,627 |

There were 145 selected records from a 228-node snapshot. One exact 1,378-byte
URL appeared eight times (11,024 bytes). References repeated the snapshot UUID;
agent-created objects also printed absent fields as `undefined`. This was largely
representation overhead, not 27.6 KB of unique reading material. The long URL
happened to belong to advertising; filtering advertising domains is not the fix.

Phase 6's prompt-only experiments did not establish efficiency gains. This phase
changes representation and recovery deliberately rather than prescribing more
agent-side compression attempts. It refines Phase 5's complete-write overflow
contract; it does not introduce conversation-history compaction.

## Objective and boundaries

Make ordinary discovery cheap enough to guide the next action, while preserving
exact data, actionability and honest coverage. Keep full structured observations
available locally and let the agent emit selected evidence through normal
console/final-value output.

In scope: a compact snapshot presentation, short scoped references, repeated-URL
factoring, bounded useful overflow previews, concise API guidance and measurement.
Out of scope: site-specific extraction, comment APIs, DOM rewriting, replacing
Playwright/AX, raw CDP, history thinning, viewer/media changes and automatic action
replay. Do not build a universal object compression framework or global symbol DB.

The comparison started with 8 KiB as a baseline, then reassessed it after the
representation changes. **The measured decision is to retain 8 KiB**, with the
existing explicit `repl.setOutputBudget(bytes)` expansion to 32 KiB available.
Results and tradeoffs are recorded below.

## 1. Compact snapshot presentation

- [x] Preserve rich `nodes`, exact strings/URLs, hierarchy, states, pointer hints,
  document identity and coverage in the retained structured observation. Output
  compaction must not lower the local materialization limit or omit source data.
- [x] Provide `snapshot.format({nodes?,maxBytes?})` for retained snapshots, including
  selected/scoped original nodes. The view also respects remaining cell space.
  It must not recapture the page, execute getters/custom inspection hooks or
  change generic console semantics. Prefer a small explicit formatter over magic
  detection of snapshot-shaped objects or a second extraction API.
- [x] Teach the compact representation as the ordinary discovery output path;
  retain plain JS projection and exact JSON for focused evidence. Returning a
  raw object remains possible, but should not be the primary discovery example.
- [x] Emit readable hierarchical records with role, useful name/text, meaningful
  state and actionable reference. Omit absent properties and JS object boilerplate.
  Do not discard generic nodes solely because they lack a semantic role: they may
  carry visible text, pointer actionability or necessary grouping.
- [x] Store snapshot identity once and use short node references within it.
  Resolution must bind to the original workspace, runtime generation, target,
  document and observation. An old short reference must never resolve to a new
  node after a later snapshot. Prefer the existing observation map and a bound
  snapshot/element handle over a new persistent alias registry.
- [x] Factor repeated exact URLs into a snapshot-local table. Nodes reference
  entries; exact URL lookup remains straightforward from retained data. Preserve
  query strings, fragments, relative spelling and base URL semantics. Do not
  normalize distinct URLs into one value or remove tracking/ad parameters.
- [x] Keep dictionary overhead proportionate: use the table for repeated values
  when it saves space; do not duplicate a large table in every small projection.
  A printed selection must include its referenced entries or explicitly identify
  how to resolve omitted values from its retained snapshot. Never leave ambiguous
  aliases that silently refer to a different observation.

The structural format is a readable view, not a new automation protocol. Snapshot
identity and URL table metadata must remain distinguishable from untrusted page
text. Equal labels/bodies do not establish entity identity: do not collapse
separate controls or nested records merely because their text matches.

## 2. Useful, explicit overflow previews

- [x] Use the existing shared console/final-value collector and artifact storage.
  Keep preceding emissions, then supply a bounded preview of the overflowing
  emission when space remains, plus an explicit omission notice and artifact
  reference. Account for preview and markers within the text budget.
- [x] Compact snapshot previews stop at record boundaries, preserve the metadata
  needed to interpret included records, and report included versus omitted scope.
  A single huge record/value must not consume the entire preview without a clear
  omission marker. Prefer deterministic formatting, not LLM summarization.
- [x] For arbitrary strings or inspected JS values, use a UTF-8-safe excerpt
  explicitly labeled as incomplete formatted text. Never present clipped JSON as
  complete/parseable data. Do not add a general JSON repair/parser subsystem.
- [x] Preserve bounded full-capture artifacts and their own truncation metadata.
  If the capture ceiling is reached, do not describe the artifact as complete.
  Keep artifact paths workspace-scoped, retention bounded and permissions private.
- [x] Preserve successful execution and retained variables on output overflow.
  No automatic retry, page query, budget expansion, mutation replay or runtime
  reset. Exceptions and possible partial effects retain their existing meaning.
- [x] Distinguish source/capture coverage, formatter preview elision, emitted-text
  overflow and agent-written slicing. `truncated:false` must not be described as
  proof that the entire page or every original body was read.

This intentionally supersedes Phase 5's rule to omit the entire overflowing
emission. Preserve one output path rather than maintaining old/new overflow modes.
Images retain existing separate limits, explicit emission and delivery fencing.

## 3. Guidance and API consistency

- [x] Replace overlapping guidance with a short example of retaining a snapshot
  and emitting its compact view or a selected projection. Keep action freshness,
  exact URL handling, coverage and private-control guidance intact.
- [x] On overflow, recommend selecting from retained structured values first.
  Artifact reads must be bounded/selected; printing an entire oversized artifact
  into the same budget is not recovery. Explain the existing explicit expansion
  option for genuinely relevant evidence that needs more room.
- [x] Avoid forcing a count/sample cell before every task. Local selection,
  formatting and emission can happen in one cell when the needed scope is known.
  Do not introduce prompt-vocabulary tests or production-site recipes.

## 4. Validate compaction first, then revisit 8 KiB

Use the existing comparison harness and neutral fixtures. Freeze baseline runtime,
prompt, model/effort, tasks and repetitions; record hashes and compare matched
runs. First compare old/new representation at the same 8 KiB default. Then compare
the improved implementation at 8, 16 and 32 KiB with otherwise identical settings.
Use repeated runs, including the high-effort setting from live reviews. Report
correctness and per-task ranges, not just aggregate byte savings.

Fixtures must cover repeated long URLs, exact query/fragment differences, multiple
identically labeled controls, nested entities, long prose with a late decisive
caveat, tables, partial loading, Unicode, huge individual values, multiple console
writes and seeded overflow after a mutation. Test the supported action path using
short references after a fresh capture, and rejection after navigation, recapture,
target closure, takeover/Return and worker reset. Test two workspaces with matching
short labels to prove they cannot cross-resolve.

Measure actual provider input/output/cache usage, peak context, emitted bytes,
unique data versus presentation overhead, model/tool calls, natural overflows,
explicit expansions, recovery turns, wall time, correctness and coverage. Verify
retained exact data stays intact and unused data stays out of model context.
Capture full traces only through existing private diagnostic controls; do not log
page content or URL tables to normal operational logs.

- [x] Deterministic fidelity and stale-reference tests pass.
- [x] Overflow preserves evidence/markers, bounded capture and exactly-once effects.
- [x] Fixed-fixture provider comparison shows whether compact output reduces
  recovery turns without losing decisive content or shifting cost to extra calls.
- [x] Inspect a supplementary real-agent run; live-site differences are not a
  controlled performance result. See [ed1 review](../../review/browser-repl-ed1-review.md):
  useful overflow recovery worked; stale scrolling, semantic selection and coverage
  guidance remain follow-ups.
- [x] **Record an explicit post-compaction budget decision:** keep 8 KiB, raise it,
  or narrowly revise expansion guidance based on measured tradeoffs. Document
  why, with call/time/coverage costs as well as tokens. No automatic/adaptive
  budget system is presumed. An inconclusive result remains an open gate.

Budget decision: keep 8 KiB. All 36 candidate fixture tasks passed across 8/16/32
KiB. The larger defaults spent more input for limited call/time savings. On the
five equally successful core fixtures, 8 KiB compaction reduced tool calls from
29 to 21 with essentially flat cumulative input, not universal token savings.
Exact-URL navigation additionally passed all six candidate runs while baseline
selected the neighboring record twice. Final-answer transcription of a long
opaque URL failed in all versions; that separate experiment is retained in the
[measurement record](../../debug/browser-repl-phase7b.md), along with ranges and
limitations. The live ed1 review confirms useful previews and budget enforcement;
broader interaction and Phase 8 lifecycle acceptance remain open.

## Ownership, contracts and implementation documentation

The service resolves the owning Bud/thread/invocation; the daemon owns workspace
and observation authority. Formatting retained historical data grants no new
live-page access. Short refs and URL aliases are not authorization tokens. Existing
per-operation and output-delivery fences still apply during private takeover.
No new browser-facing route, database table, owner stamping or migration is planned.

Read and update affected specs during implementation:

- [Helper](../../bud/browser-helper/browser-helper.spec.md) and its README: formatter,
  reference/URL mapping, worker output and packaging of any new module.
- [Daemon browser](../../bud/src/browser/browser.spec.md): observation resolution
  and execution/result handling if affected.
- [Service browser](../../service/src/browser/browser.spec.md) and
  [agent](../../service/src/agent/agent.spec.md): result fidelity and API guidance.
- [Scripts](../../service/scripts/scripts.spec.md): comparison cases/metrics.
- [Protocol](../../docs/proto.md): changed output semantics/fields where applicable;
  use snake_case for Bud-owned wire fields. Avoid a new envelope if existing
  artifact and truncation fields suffice.
- [REPL design](../../design/browser-repl.md), parent plan and Phase 8: current
  semantics, measured budget decision and remaining acceptance.

Record implementation choices, exact validation commands and outcomes in a debug
note. Update earlier phase documents to mark superseded output rules explicitly;
historical reviews remain factual records of what ran.

## Coordinated rollout

Use matching service guidance, daemon archive and prepared helper; drain cells and
restart affected workers as a coordinated development upgrade. Bindings lost to a
restart remain an explicit runtime reset; do not replay historical cells or add
legacy reference/formatter aliases just for hypothetical mixed-version users.
No web/mobile build is expected unless implementation changes a shared contract.
Phase 8 remains the final merge gate and must include this phase's validation and
budget decision. This plan authorizes no deployment, restart, commit or merge.
