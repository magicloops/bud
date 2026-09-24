# Plan: Persistent browser REPL implementation

Status: Phases 1–3 implemented; live observation/navigation and an actual-agent
draft-fill task passed. Broader interaction and physical viewer acceptance remain.
Phase 4 output controls and comparison harness implemented; controlled provider comparison
passed 18/18 tasks; lifecycle acceptance and catalog cutover remain. 2026-09-23.

Validation and implementation decisions:
[runtime foundation](../../debug/browser-repl-runtime-foundation.md).
Non-production services default to the capability-gated REPL observation
experiment. Set `BUD_BROWSER_TOOL_MODE=tools` to compare the old catalog.
See [Phase 2 validation](../../debug/browser-repl-selective-observations.md).

## Objective and references

Implement [the REPL design](../../design/browser-repl.md) through the original
four phases and the Phase 5–7 output, extraction and interaction refinements below,
then Phase 7b snapshot/output compaction and budget reassessment, Phase 7c scrolling
and observation use, followed by
Phase 8 workspace lifecycle and final merge acceptance. Keep page data in a thread's Node workspace and send only deliberately
emitted evidence to the model. Preserve the shared Chrome profile, thread-owned
tabs, user control, recovery, viewer and existing agent loop.

Evidence: [transcript thinning](../../debug/browser-ce762991-context-thinning.md)
and [context alternatives](../../design/browser-context-condensation.md).
Runtime references: [helper](../../bud/browser-helper/browser-helper.spec.md),
[daemon](../../bud/src/browser/browser.spec.md),
[service browser](../../service/src/browser/browser.spec.md),
[agent](../../service/src/agent/agent.spec.md),
[protocol](../../docs/proto.md), and
[mobile viewer](mobile-viewer-contract.md).

These are implementation checkpoints, not independently supported products.
Phase 2 provides the first actual-agent experiment. Phase 4 removes the temporary
comparison selection and old executable tool catalog. No implementation phase
requires a new compaction subsystem or general request-building refactor.

## Architecture and ownership

The service resolves owner, Bud, thread and invocation through existing authorized
repositories before dispatch. Tool arguments contain code, not authority or Chrome
connection details. Existing messages/actions inherit the thread owner. No new
browser-facing route or database table is planned.

The daemon owns one lazy, killable Node worker per existing browser workspace,
using the prepared add-on's Node and pinned helper packages. Chrome ownership and
profile lifetime remain independent. Generated JavaScript is trusted host code,
like terminal execution; worker separation is for lifecycle and failure handling,
not an OS sandbox or protection against malicious host code.

Use a small private worker-to-daemon operation bridge. The worker executes local
JavaScript and sends typed facade requests; the daemon validates the active cell,
workspace and authority before routing to existing browser operations/helper.
Responses may carry bounded structured data locally without first serializing it
into the model-facing compact format. Reuse the semantic engine and native Playwright click path
(Phase 7); do not duplicate a second automation implementation in the REPL worker.

Cell admission must not hold the existing shared page lock for the entire cell.
Each supported browser operation acquires/releases that lock with authority checks;
local filtering, imports and file work do not. Control closes admission immediately
and drains active cells/tracked operations before acknowledging private input.
Private stdio framing must separate bridge traffic from captured console output.
No new network listener or generic RPC framework is needed.

## Phase 1 — Worker, execution receipts and control foundations

Deliver a tested internal execution path before exposing it to the model.

- [x] Inspect the current executor/broker/manager/helper paths in full and map the
  cell boundary separately from page-operation serialization. Define the small
  local bridge and wire/result shapes in `docs/proto.md` before implementation.
- [x] Add a workspace-local runtime owner and a separate helper worker entrypoint.
  Support persistent bindings and top-level await with the managed Node runtime.
  Verify evaluation/redeclaration semantics on that pinned runtime; avoid building
  a JavaScript parser or exposing an inspector network port.
- [x] Serialize cells per workspace. Associate every operation with its active cell
  and invocation fence; reject late/background facade calls after cell completion.
  Track outstanding supported calls even when code forgets to await them.
- [x] Reuse durable action identities and receipts. Duplicate delivery returns a
  known receipt; missing/ambiguous receipts never rerun code. Distinguish never
  started, completed, failed with possible partial effects, and interrupted.
  Never classify a whole mixed cell as safely rejected just because its last
  browser operation was blocked.
- [x] Preserve variables after ordinary exceptions. Terminate a stuck worker on
  the bounded execution deadline or running-cell cancellation when required;
  change runtime generation and emit an honest reset reason. Canceling an
  unstarted/parked cell preserves the worker. Cleanup removes child workers on
  workspace destruction, ownership change and daemon shutdown.
- [x] Integrate existing Bud-wide takeover admission, durable browser waits and
  Return-to-agent continuation before enabling page access. Drain active cells
  and tracked operations within a single bounded acquisition deadline; terminate
  only workers that cannot drain. Do not acknowledge private control early.
- [x] Preserve worker memory and runtime generation on normal takeover/return;
  invalidate observation/action references and fence delayed results/images.
  Require fresh observation after Return. Parked cells resolve as not executed
  for replanning, not automatic replay or suspended-stack resumption.
- [x] Bind all supported browser access to current authority. Preserve historical
  local data without treating it as permission to read private pages. Raw host
  access remains outside this cooperative control guarantee.
- [x] Package new helper modules through the existing archive/build watch list.
  Worker failure must not poison the semantic helper, shared Chrome or viewer.

Start with the design's 30-second cell deadline, bounded code/IPC payloads and
one worker per admitted workspace. Measure worker memory using the existing
128 MiB helper heap as a starting comparison, then choose one documented worker
limit. Define one acquisition deadline within existing control request/lease
budgets; do not stack an additional full cell deadline onto a control timeout.
A receipt must record the authoritative outcome even if its output can no longer
be delivered after takeover. No page-bearing content in operational diagnostics.

Acceptance: bindings survive follow-up cells and clean takeover; a synchronous
infinite loop can be terminated without blocking heartbeats/control; two threads
cannot cross workspace boundaries; duplicate/canceled cells do not rerun. Cover
service reconnect with a surviving worker, worker crash, daemon restart, late
operation/output races, lost acknowledgement and partial mutation. Reuse isolated
repository tests for ownership and receipts. This phase is not agent-enabled.

## Phase 2 — Selective observations through the actual agent

Deliver the first measurable vertical slice, with Phase 1 protections active.

- [x] Add `browser_exec({code})` to the existing tool execution path and an explicit
  daemon capability. Use one development-only catalog selection for comparison:
  either existing browser tools or REPL plus the existing handoff tool, never both
  in the same model request. Unsupported peers fail clearly before execution.
- [x] Provide tabs current/list/get/open, navigation/info, hierarchical and scoped
  snapshots, visible DOM, frame-scoped evaluation and viewport screenshots.
  Minimal open/navigation is needed for independent real-agent tasks in this
  phase; it uses the same mutation/receipt rules as later actions.
- [x] Keep snapshot materialization separate from emitted output. Reuse the
  retained-tree ceiling (currently 2 MiB) or consume frozen pages locally. Preserve
  hierarchy, exact URLs, document/capture identity, states and partial-coverage
  metadata. Never silently return only the first 32 KiB as a complete snapshot.
- [x] Return JSON from `evaluate(fn, jsonArgument)` without Node lexical capture.
  Treat evaluation as potentially mutating, with no automatic retries or purity
  analysis. Keep raw CDP/unwrapped Playwright outside the supported API.
- [x] Original Phase 2 output contract (superseded by Phase 5): explicit text/image
  emission and console capture; Phase 5 removes `repl.write` and displays successful
  final non-undefined values.
  Use 32 KiB emitted text plus a bounded envelope, a 1 MiB captured-text file
  ceiling, and at most two validated image emissions per cell.
- [x] Keep local artifact paths scoped to the authorized workspace with restrictive
  permissions. Provide simple bounded read/write helpers and truncation notices.
  Define storage cleanup on workspace destruction and bounded artifact retention
  so repeated cells cannot accumulate unlimited output. No UI artifact route or
  new service artifact database is required.
- [x] Extend existing image upload/storage/hydration to associate multiple emitted
  images with one cell. Recheck authority at delivery; retain existing replay
  limits and model vision gating. Never send base64 in tool text. Preserve text,
  image references and artifact references through live output and replay.
- [x] Connect operation-driven viewer updates at safe browser-operation/cell
  boundaries. Coalesce local extraction loops; pure local filtering sends no new
  capture. Viewer images do not automatically enter model context.
- [x] Add concise tool guidance for persistent variables, selective extraction,
  explicit output, fresh observations, exact URLs, reset notices and untrusted
  page content. Keep existing conversation compaction and provider accounting.

Acceptance: the real Bud agent opens a fixture/site, retains a substantial
snapshot, emits a small selected subset, answers a follow-up from retained data
and deliberately requests an image. Confirm unused data stays out of provider
requests and ordinary transcript records. Verify oversized Unicode output,
truncated internal captures, image replay, artifact recall and text-only models.
Exercise actual-agent handoff/Return in this experiment, including memory retention.
Do not defer privacy or cancellation checks until the full action API exists.

Phase 2 live checkpoint: thread `3297763e-fb32-403d-b30b-57baa1594e72`
confirmed selective extraction, exact-URL navigation, screenshot emission and
follow-up reuse. Seven continued-task cells succeeded with 31.3 KiB emitted text
and one screenshot; provider input grew from 19,017 to 33,182 tokens. This is
observation/navigation acceptance, not click or real-user handoff acceptance.
The remaining device/handoff checks are tracked with Phase 3 below.

## Phase 3 — Complete interactions and lifecycle acceptance

Deliver the full intended replacement for the existing browser tool family.

- [x] Expose existing reference and exact role/name actions, fill/focus/text/scroll,
  tab selection/close and supported navigation through the facade. Reuse bounded
  native Playwright actionability (Phase 7 replaces randomized preparation). No
  forced clicks, sibling substitution or automatic navigate-after-click fallback.
- [x] Distinguish reusable workspace/tab identity from document/observation-bound
  references. After navigation or control changes, cached data remains available
  but old action references reject; refreshing an owned tab cannot revive stale
  element evidence. Explicit close destroys the appropriate workspace/runtime
  only according to the existing close contract.
- [x] Cover mixed local/read/action cells and partial failures: an earlier mutation
  remains possible even if a later operation fails. End-of-cell success means code
  completed, not that a website accepted an action or navigation reached its goal.
- [x] Verify recovery remains demand-driven. Runtime replacement invalidates live
  handles; it does not replay a pending cell. Browser/profile restoration and
  JavaScript heap loss are separate facts in results and agent guidance.
- [x] Reuse inline Return/Cancel and existing acquisition presentation. Change
  shared web/mobile contracts only if current state cannot express bounded
  acquisition/reset; do not add a second control workflow or native REPL UI.
- [ ] Verify two workspaces, private capture/input, fitting, minimized headed
  capture and passive viewer continuity under long cells and exceptions. Killing
  a Node worker does not undo Chrome-side work; preserve uncertain outcomes.

Acceptance: fixed layered-feed and nested-comment tasks plus actual-agent runs
can find the Nth non-ad post, open its link rather than adjacent media, summarize
comments and answer later detail questions. Include virtualization, full query/
fragment URLs, iframes, stale references and partial coverage. Test web and physical
iPhone over ngrok for takeover during execution, Return, cancellation, reconnect
and daemon restart. Observe no private-content delivery, duplicate actions or
viewer resets caused solely by an ordinary cell/action error.

Implementation decisions and automated results: [Phase 3 validation](../../debug/browser-repl-interactions.md).
Subsequent live evidence: [thread 69229029](../../debug/browser-repl-692-context.md)
successfully used reference fill and verified an unsent draft. It also exposed
output-volume and API-usage regressions tracked in Phase 4. The earlier missing
interaction methods came from a stale extracted helper; the
[archive identity fix](../../debug/browser-helper-cache-identity.md) prevents
same-version dirty builds from silently reusing the old managed helper.
`tabs.open` retains ensure-and-navigate behavior; `tabs.create` always creates a
new tab. `tab.select` is logical viewer selection, not native window activation.
`tab.close` closes one tab, removes its recovery hint and preserves REPL memory;
workspace close/reset retains its existing worker-destruction contract.
Element handles bind the observation at construction. New snapshots, navigation
and Return invalidate them; neither retained tab identity nor a fresh snapshot
revives an old handle. Whole failed cells retain uncertain-effect semantics.

## Phase 4 — Comparison, coordinated cutover and cleanup

Implementation/measurement record: [Phase 4](../../debug/browser-repl-phase4.md).
The candidate default is 8 KiB, explicitly expandable to 32 KiB per cell through
`repl.setOutputBudget(bytes)` before output. Phase 7b supersedes complete-write
omission with explicitly incomplete excerpts and the existing bounded artifact;
clipped JSON is never presented as complete, and actions are never replayed. Local capture
coverage stays unchanged. The comparison harness runs actual provider calls
against disposable Chrome/helper/worker fixtures; it does not substitute for
physical web/iOS private-control acceptance.

Final fixed-fixture comparison: 18/18 tasks correct on `gpt-5.6-luna`, low
reasoning, three repeats per catalog/task. REPL lowered median cumulative input
on table, article and form tasks, but table tasks took more calls/time and one
article run expanded broadly. See the measured ranges/outlier in the record.
The catalog-removal step stays pending physical lifecycle acceptance; no
production cutover was performed.

- [x] Tune agent guidance using the live-run follow-ups below; validate behavior
  on fixtures and transcripts rather than tests that assert prompt wording.
- [x] Evaluate a smaller default emitted-text budget with explicit per-cell
  expansion within a documented hard ceiling. Keep full observations available
  locally at the existing materialization limits; output budgeting must not
  reduce page coverage. Apply one shared budget to explicit writes and console
  output. Oversized structured output should yield useful overflow feedback and
  a local artifact reference, not silently cut JSON presented as a complete
  result. Let the agent select fewer fields from retained data or deliberately
  request more output without repeating browser actions. Choose defaults from
  varied-task measurements, not a single site's transcript.
- [x] Run old tools and REPL on the same fixed fixtures/tasks, model/reasoning
  settings and budgets; repeat enough to expose variability. Record actual
  provider input/output/cache usage, peak context, total calls, duration,
  correctness and failures, including generated code and errors. Live sites are
  supplementary evidence, not a controlled context comparison.
- [ ] Require correct association/coverage and reliable handoff/recovery, plus a
  repeatable reduction in emitted observation volume and provider context for
  selective tasks. Set no invented savings percentage. Investigate regressions
  before cutover; do not disguise them with simultaneous compaction changes.
  History thinning remains a separate follow-up: first measure the residual
  cost after selective emission and output controls, then scope preservation of
  useful facts/action outcomes and retirement of superseded observations.
- [ ] Make `browser_exec` plus `browser_request_handoff` the sole executable
  browser catalog. Remove the temporary comparison switch and old model-facing
  open/observe/act/close schemas, dispatch branches and obsolete prompt guidance.
  Retain internal implementations used by the facade/viewer and rendering/replay
  of historical tool records. Do not add executable legacy aliases.
- [ ] Update capability/catalog tests, provider tool-result/image paths, context
  accounting and user-facing labels where necessary. Keep terminal and public
  web search/read tools unchanged. Remove duplicate output/lifecycle paths made
  obsolete by this change, without unrelated architectural cleanup.
- [x] Document exact versions and coordinated upgrade order: drain active browser
  cells, prepare/install matching daemon/add-on and service/shared web, restart,
  verify capability and run a real-agent smoke task. Do not execute with a stale
  helper. Native iOS needs a new build only if its hosted-viewer bridge changes.
  Roll back the matched stack if needed; in-memory bindings cannot be restored.

Acceptance: a fresh and an existing thread both use only the new catalog; old
history still loads; unsupported installations fail clearly; packaged helper
contents include every runtime dependency. Record outstanding platform acceptance
honestly. Linux display/secure-store support, WebRTC, keyboard/files/clipboard
expansion and personal-browser attachment remain their own plans.

### General agent guidance follow-ups

Keep guidance short and applicable across sites. Validate these behaviors on
varied tasks and page structures before deciding what belongs in the prompt.

- [x] **Select evidence before emitting it.** Retain useful observations in the
  REPL, perform filtering and aggregation locally, and emit what the next decision
  or answer needs. Avoid repeatedly emitting the same records. Refresh when the
  task requires current state; cached observations are historical evidence.
- [x] **Match claims to evidence coverage.** Distinguish complete reads from
  samples, slices, unloaded content and partial captures. Preserve coverage
  information through local transformations. `truncated:false` only describes
  tool-output truncation, not whether the agent inspected the whole source.
  Gather more evidence when needed, or qualify the answer's scope.
- [x] **Validate extraction assumptions.** Establish which page elements
  represent the requested entities and how ordering, grouping and exclusions
  work. Preserve relationships between each entity and its text, links and media.
  Check ambiguous selections against observed structure before acting or making
  claims. Use task-relevant evidence rather than assuming a selector proves
  semantic identity or completeness.
- [x] **Verify outcomes.** Successful execution does not prove the intended
  result occurred. Inspect relevant state after an action and distinguish
  observations from inferences. Choose the supported action appropriate to the
  task; do not prescribe one interaction method for every site.
- [x] **Make API contracts easy to use.** Document the actual return shapes
  (including the `nodes` field on snapshot/visible-DOM results), reference
  lifetimes and reset behavior with concise examples. Distinguish reusable local
  data from current action references. Reacquire handles after observations or
  other invalidating events; do not recover from a shape error by dumping the
  whole result. Verify the affected element or page state rather than unrelated
  fields, full forms or application internals. Dynamic replacement may require
  fresh evidence even after an action reports success.

Validation should cover selective lookup, comparison, summarization and state
changes across forms, tables, search results, articles and dynamic applications.
No site-specific selectors, ad filtering or post/comment workflow rules belong
in the general guidance. Measure correctness and emitted context as well
as API success. Interaction and lifecycle coverage remains in Phase 3; a successful
navigation-only task does not establish click or form-interaction reliability.

Supporting evidence: thread `3297763e-fb32-403d-b30b-57baa1594e72`, September 23,
2026. Its continued task completed seven browser cells, emitted 31.3 KiB of text
and one screenshot, and grew provider input context from 19,017 to 33,182 tokens.
The follow-up reused existing evidence. Repeated extraction and overbroad claims
from a partial read motivated the general guidance above. This single run is not
a controlled savings comparison or full acceptance. The initial API argument
misunderstanding is recorded in [the investigation](../../debug/browser-repl-viewer-status.md).

Additional evidence: [thread 69229029](../../debug/browser-repl-692-context.md)
used the working interaction API, but broad output and verification detours grew
provider input from 14,008 to 76,875 tokens. Three broad outputs preceded about
73% of that growth. This motivates general emission controls and clearer API
contracts, not site-specific filtering or a predetermined output budget.

## Phase 5 — Standard REPL output and agent guidance (implemented)

[Phase 5 plan](repl-phase-5-standard-output.md): remove `repl.write` entirely,
make console output and the final non-undefined completion value the text surface,
and simplify general selective-evidence guidance. Console capture already exists;
final-value emission is new. This supersedes Phase 2's silent-final-expression
contract. Keep existing browser authority, explicit images and
output budgets; no extraction-specific helpers or simultaneous compaction work.

Motivated by [the 8b60 live review](../../debug/browser-repl-8b60-review.md).
Implemented before Phase 4 catalog cutover; its outstanding correctness,
efficiency and physical lifecycle acceptance gates remain open.
See [Phase 5 validation](../../debug/browser-repl-phase5.md) for measured results
and the outstanding live product check.

Follow-up evidence: [4462398b review](../../debug/browser-repl-446-review.md)
found lower context but more output retries and lossy DOM extraction. The
[accessibility representation spike](../../debug/browser-accessibility-spike.md)
compares native Chrome AX, Pi's projection and Bud's Playwright path. It does not
support switching to AX for size alone, and identified dropped string children
and pressed states in Bud. The [fidelity fix](../../debug/browser-snapshot-fidelity.md)
preserves those fields with targeted Chrome regressions; the corrected spike
still favors Bud's size on HN. Selective extraction is scoped in Phase 6 below.

## Phase 6 — Selective extraction and efficient output recovery (evaluated)

[Phase 6 plan](repl-phase-6-selective-extraction.md): the expanded comparison harness
now tests retained evidence, record boundaries, coverage and local overflow recovery
across eight neutral fixtures on the same corrected Phase 5 runtime.

All 48 final runs passed correctness checks. Three prompt candidates were tested
and reverted: the final narrow reuse cue increased ordinary-task cumulative input
by 18.8% and added six tool calls. The Phase 5 guidance remains unchanged by Phase 6.
See [measurements](../../debug/browser-repl-phase6.md) for per-task results and
limitations. Evaluation tooling is implemented; efficiency acceptance and the
supplementary live product check remain open. No new extraction API,
accessibility-layer switch, budget policy or compaction change was added.
Phase 4 lifecycle and catalog-cutover gates remain open.

## Phase 7 — Faithful interaction targets and native clicks (implemented locally)

[Phase 7: Faithful interaction targets and native clicks](repl-phase-7-actionability.md)
now uses normal Playwright clicks, preserves pointer hints and real references,
and exposes element geometry/optional positions for covered cards. The mandatory
sampler and its error/diagnostic paths are removed. No discovery API was needed.
See [validation](../../debug/browser-repl-phase7.md); supplementary live-product
acceptance remains. Phase 4 lifecycle/catalog-cutover and Phase 6 efficiency
acceptance remain open.

## Phase 7b — Compact snapshot output and overflow previews

Plan: [Phase 7b](repl-phase-7b-output-compaction.md). Implemented locally;
see [validation and budget evaluation](../../debug/browser-repl-phase7b.md).
Supplementary [ed1 live review](../../review/browser-repl-ed1-review.md) confirms
compact views and useful overflow recovery; stale-scroll and evidence-selection
follow-ups remain.
Preserve rich local observations while compacting emitted snapshots through short
scoped references, exact repeated-URL factoring and omission of absent fields.
Replace whole-emission omission with clearly marked bounded previews using the
existing output/artifact path. Validate at the current 8 KiB baseline first,
then reassess 8/16/32 KiB budgets against calls, latency, coverage and
actual provider usage. Completed comparison retains 8 KiB with explicit expansion;
all 36 candidate tasks passed, with mixed per-task token tradeoffs. This phase refines Phase 5 output semantics; it does not
add history thinning or site-specific extraction. Phase 8 remains the final gate.

## Phase 7c — Reliable scrolling and focused observation use (scoped)

[Phase 7c plan](repl-phase-7c-observation-use.md) follows the
[ed1 review](../../review/browser-repl-ed1-review.md). Investigate stale page-scroll
invalidation first, preserving ownership/private control and element freshness.
Then evaluate concise guidance distinguishing semantic roles from HTML tags,
refreshing without reprinting, selecting retained evidence and honest coverage.
Keep 8 KiB; no automatic diffing, specialized extraction or history thinning.

## Phase 8 — Workspace admission, cleanup and final merge acceptance (scoped)

[Phase 8 plan](repl-phase-8-workspace-lifecycle.md) is the final pre-merge phase.
Resolve invisible workspace exhaustion, lifecycle cleanup and accurate capacity
recovery using existing ownership and close paths. The interim ten-workspace cap
is implemented and tested; it is not the completed lifecycle policy.

This phase also closes out the earlier outstanding lifecycle, catalog-cutover,
efficiency and interaction acceptance gates from recorded evidence. It does not
supersede them or make unrelated platform/media roadmap work a merge prerequisite.
Do not mark the REPL change ready to merge until this phase's checklist is complete.

## Documentation, contracts and completion

- [ ] Update helper, daemon browser, service browser, agent and affected runtime/
  LLM specs as each phase changes APIs or files; add file descriptions for new
  modules. Update build/add-on documentation for new packaged worker sources.
- [ ] Document snake_case Bud-owned wire fields, capability, bounded payloads,
  receipts, runtime generation, output and image semantics in `docs/proto.md`.
- [ ] Update the [auth validation checklist](../init-auth/validation-checklist.md)
  for ownership/stream changes; no global convenience lookups or client-chosen
  workspace authority. Any unexpected new row must inherit owner/tenant stamps.
- [ ] Update viewer/mobile docs only for changed contracts. No schema migration is
  planned; if receipts require a schema change, scope it explicitly and follow
  push/generate/migration validation before shipping.
- [ ] Record commands/results per phase, including skipped opt-in tests and device
  checks. Run focused helper/daemon/service/viewer tests and relevant builds;
  package-local commands must run from their owning directories.
- [ ] Mark design/plan status and TODOs from evidence. Keep failures in a debug
  note, not as unexplained acceptance exceptions. No commit/deploy is implicit in
  completing a phase.

Phase 1 settled the bridge, native evaluator, acquisition deadline and execution
limits; see its validation note. Phase 2 settles artifact retention and the typed
facade using the current helper. These remain bounded implementation choices,
not separate product subsystems.

## Current checkpoint and next implementation step

The daemon now accepts an internal `exec` command on an allocated workspace,
supervises a separate managed Node worker, and serves a strictly allowlisted
operation bridge through existing browser implementations. Normal takeover keeps
the heap; stalled execution, active cancellation, process death and interrupted
execution reset it with explicit metadata. Output is withheld after authority or
invocation loss. A disposable Chrome fixture verifies observation, private Return,
stale-reference rejection and a fresh successful click.

Phase 1 now includes service-owned, immutable cell receipts in existing action
evidence, bounded wire results and durable wait/Return continuation. Duplicate
requests return authorized receipts; absent acknowledgements remain unknown and
never cause code replay. Completion preserves independent Chrome health. Tests
cover cancellation, worker/daemon restart, reconnect, takeover, late output,
partial effects, action/transcript persistence and real Chrome isolation.

Phase 2 supplies the typed observation facade, full local snapshots, evaluation,
explicit image emission and bounded local files. `tabs.open(url)` currently ensures
and navigates this workspace's current page, matching existing Open semantics;
Phase 3 adds explicit additional-tab creation/selection/close.
There are no new routes, migrations or web/mobile contracts. Matching service,
daemon and prepared helper are required. Production activation remains Phase 4.

Automated acceptance includes the actual AgentService loop with a scripted provider,
real-Chrome daemon/semantic fixtures, retained-data worker tests, image hydration,
private-control and durable receipt regressions. Phase 4 adds complete-write overflow, explicit cell output expansion, clarified
API guidance and the fixed-fixture provider comparison recorded above. The real
provider-driven observation task passed as recorded above. Physical
viewer handoff/Return and actual-agent interaction acceptance remain before
coordinated catalog cutover.
