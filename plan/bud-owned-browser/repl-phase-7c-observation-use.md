# Phase 7c: Reliable scrolling and focused use of observations

Status: scoped, not implemented. 2026-09-24.
Runs after [Phase 7b](repl-phase-7b-output-compaction.md), before
[Phase 8 final acceptance](repl-phase-8-workspace-lifecycle.md).
Parent: [REPL implementation](repl-implementation.md).
Evidence: [ed1 live review](../../review/browser-repl-ed1-review.md).

## Objective

Remove unnecessary observation/recovery work while keeping actions correctly
owned and answers grounded in the evidence actually read. Keep this a narrow
runtime investigation and a measured guidance change, not a new extraction or
context-management subsystem. The text budget remains 8 KiB with explicit expansion.

The latest main task completed in 49 seconds with eight cells versus 69 seconds
and fifteen cells previously. Useful overflow excerpts worked. Remaining costs
were one stale scroll, duplicate feed previews and two empty DOM queries based on
accessibility roles. Final context did not shrink. These are distinct issues and
must not be bundled into one presumed root cause.

## 1. Investigate and fix stale page scrolling

- [ ] Write a debug note and trace the observation lifecycle across the facade,
  semantic engine, daemon bridge, viewer capture/resize and concurrent workspaces.
  Identify which paths replace or invalidate semantic observations. The failed
  scroll in ed1 was about 25 seconds after capture (below the 60-second TTL), and
  later capture had the same target/document; neither ordinary expiry nor a
  proven top-level navigation explains it.
- [ ] Reproduce the invalidation with neutral fixtures before choosing a fix.
  Include child-frame navigation, another workspace's snapshot, ordinary evaluate,
  viewer capture/fit and elapsed observation time. Do not assume all are causes.
- [ ] Separate the contract for page-level scrolling from element targeting.
  Preferred direction, if confirmed by investigation: resolve the currently owned
  live tab and allow one page scroll without an element snapshot dependency.
  Scrolling acts on the current page, like other page-level operations; it does
  not claim an old element or document is unchanged. Document navigation races
  and require subsequent observation before referring to page contents.
- [ ] Retain active-cell/invocation checks, target/workspace ownership, Bud-wide
  private-control fences, serialization, finite/bounded delta validation and
  uncertain-outcome handling. If a target closes or ownership changes, fail
  clearly; do not reopen it or choose another tab implicitly.
- [ ] Preserve stale-reference rejection for click/fill/focus/geometry and scoped
  observations. Do not weaken element evidence to make page scrolling work.
  Never auto-replay a failed cell or repeat a scroll whose effect is uncertain.

If the reproduction instead exposes accidental shared-state invalidation, fix the
smallest responsible path. Do not add per-tab observation caches, timers or a new
retry framework without evidence that they are necessary. Log canonical reasons
only through existing diagnostics; no normal-log page content or full URLs.

## 2. Tighten general guidance in place

- [ ] Clarify that snapshot roles are semantic roles, not HTML tag names.
  A role named article may be a custom element or live in a shadow tree; a literal
  CSS query returning nothing does not contradict accessible snapshot content.
- [ ] Prefer selecting relevant retained nodes with entity boundaries before
  guessing DOM selectors or recapturing the same content. Evaluate remains useful
  when the task needs information the retained representation does not provide.
- [ ] Clarify that refreshing an observation for an action does not require
  printing it. Emit only the evidence needed for the next decision, verification
  or answer. Do not mandate a count/sample call before every task.
- [ ] Explain once that format maxBytes bounds a view within remaining cell space;
  explicit setOutputBudget is needed before genuinely larger output. Avoid
  overlapping rules, site-specific examples or an enlarged prompt checklist.
- [ ] Match answer scope to loaded/captured/emitted/read evidence. Preserve
  omissions through selection; tool truncated:false does not mean complete page
  or discussion coverage. Gather missing evidence when needed or qualify claims.

Replace existing overlapping instructions rather than stacking a second policy.
No dedicated comment extraction, automatic snapshot diffing/deduplication,
wrapper suppression, history thinning, raw CDP or default-budget increase.

## 3. Validate the runtime and guidance separately

### Runtime regressions

- [ ] Reproduce the confirmed stale-scroll cause; the chosen fix allows exactly
  one intended page scroll and does not require emitting another broad snapshot.
- [ ] Cover no snapshot, expired snapshot, recapture, top-level and child-frame
  navigation, target closure and two workspaces according to the chosen contract.
- [ ] Reject unauthorized target access, private takeover and late operations;
  cancellation/transport loss cannot replay movement. Old element references
  still fail after their documented invalidation boundaries.
- [ ] Verify operation-driven viewer updates still reflect successful scrolls
  without resetting the viewer or permitting private output delivery.

### Guidance evaluation

- [ ] Freeze baseline/candidate guidance and use the existing actual-provider
  comparison harness at the same 8 KiB budget/model/effort, with repeated runs.
  Add only missing neutral fixture coverage: semantic roles on nonmatching tags,
  nested entities, partial loading/coverage, and a follow-up that can reuse data.
- [ ] Measure correctness, coverage, tool calls, empty-query detours, emitted text,
  provider input/output/cache usage and elapsed time. Include failures and mixed
  results. Do not add tests asserting particular prompt vocabulary.
- [ ] Keep only guidance changes with demonstrated value or a clearly documented
  correctness benefit. Revert wording that adds calls/context without improving
  correctness; Phase 6 showed that plausible reuse prompts can regress behavior.
- [ ] Review one supplementary live run. Verify evidence attribution and explicit
  coverage, not merely fewer calls. No exact performance threshold is presumed.

## Ownership and affected components

Service resolves the owning Bud/thread/invocation; daemon resolves the owned tab
and current browser authority before every operation and fences output delivery.
Historical local snapshots confer no authority. No browser-facing route, owner
stamping change, database table, new permission or migration is expected.

Read/update the helper spec and README, daemon browser spec, service agent spec,
REPL design, this phase and the parent plan as their behavior changes. Update
`docs/proto.md` if the scroll request/validation contract changes. Extend existing
ownership regressions; add auth checklist entries only for changed browser-facing
surfaces. Record commands, results and skipped acceptance in the debug note.

## Rollout and completion

Coordinate matching service guidance, rebuilt daemon and prepared helper; drain
active cells and restart affected workers. Existing runtime-reset semantics apply;
no compatibility alias or second scrolling path for hypothetical old installs.
No native mobile/web build is expected unless a shared viewer contract changes.

This phase is complete when the stale-scroll decision is supported by a reproduced
cause and regressions, guidance is evaluated with outcomes recorded, and live
follow-up is reviewed. Phase 8 remains the final merge gate. This document itself
does not authorize deployment, restarts, another commit or merge.
