# Design: Persistent browser REPL

Status: Phases 1–3 implemented with REPL as the development catalog default.
Live observation/navigation acceptance passed; interaction/device acceptance and
Phase 4 comparison/cutover remain.

Implementation: [phased delivery plan](../plan/bud-owned-browser/repl-implementation.md).

Date: 2026-09-23

## Goal and decision

Give the agent a persistent JavaScript workspace for browser discovery, extraction
and interaction. Large intermediate observations stay in Node memory or files;
only deliberately emitted evidence enters model context. Reuse Bud's persistent
Chrome profile, thread workspaces, semantic actions, viewer and handoff flow.

Treat generated JavaScript as trusted agent code with the same general machine
access trust model as terminal execution. Preserve service authorization and
user/agent coordination. Do not turn this project into a new execution sandbox
or claim private control isolates credentials from arbitrary host code.

Node already ships with the prepared browser add-on. Reuse that managed runtime
and pinned Playwright dependency; do not require users to install Node separately.

Related:

- [Context condensation options](browser-context-condensation.md)
- [Transcript thinning evidence](../debug/browser-ce762991-context-thinning.md)
- [Click targeting and URLs](browser-click-targeting-and-link-urls.md)
- [Automatic recovery](browser-automatic-recovery.md)
- [Context checkpoints](context-compaction.md)
- [Helper spec](../bud/browser-helper/browser-helper.spec.md)
- [Daemon browser spec](../bud/src/browser/browser.spec.md)
- [Agent spec](../service/src/agent/agent.spec.md)

Reference reviewed: local `browser-use-pi` checkout at `fa838f3`, particularly
`review/context-and-compaction.md` and `src/{worker,runtime,page,context,agent}.ts`.
Its useful patterns are persistent bindings, selective output, captured-output
files and summary checkpoints. Its raw-CDP action surface and session/history
model are not requirements for Bud.

## Scope

Include persistent top-level await/bindings, programmatic observations, page
evaluation, semantic interaction, explicit screenshots, bounded output, useful
errors, workspace files and integration with the existing control lifecycle.

Exclude a second agent loop, browser/profile replacement, heap restoration across
daemon restarts, new site-specific extraction tools, automatic DOM deltas, a
browser-only compactor, vector retrieval, and a general OS sandbox. Existing
terminal tools remain separate. This is not a way around private control.

## Agent-facing contract

Use one main execution tool, provisionally `browser_exec({code})`, plus the
existing `browser_request_handoff({reason})`. Move open/observe/act/close into the
JavaScript API. Do not expose two competing browser tool families indefinitely.
Keep the handoff tool outside the REPL so durable parking does not depend on a
suspended JavaScript stack surviving a service or worker restart.

The daemon chooses the workspace from the authorized invocation. Code arguments
cannot choose another Bud, owner, thread or Chrome endpoint. The first cell lazily
initializes its worker; opening a tab is explicit or uses existing workspace
recovery when the agent requests the current tab.

Proposed small API (names to settle in implementation):

```js
var tab = await browser.tabs.current(); // recover this workspace when possible
// Or: var tab = await browser.tabs.open('https://example.com');
var snapshot = await tab.snapshot();
var links = snapshot.nodes.filter(node => node.role === 'link');
repl.write(links.map(node => ({
  ref: node.reference, name: node.name, url: node.url
})));
```

```js
await tab.getByRole('link', {name: 'Observed title', exact: true}).click();
var pageInfo = await tab.info();
repl.write(pageInfo); // a dispatched click alone does not prove arrival
```

```js
var records = await tab.evaluate(() =>
  [...document.querySelectorAll('article')].map(article => ({
    heading: article.querySelector('h2')?.textContent,
    text: article.textContent
  }))
);
repl.write(records.slice(0, 3));
```

The selector example illustrates local extraction, not a universal post parser.
The agent must first inspect structure and verify associations, coverage and
classification. Scope to frames explicitly where necessary.

Supported operations should cover tabs list/open/get/close; info and navigation;
hierarchical snapshot/scoped snapshot and visible DOM; reference and exact
role/name actions; fill/focus/text/scroll; page evaluation; viewport screenshots.
Use existing implementations rather than rebuild their semantics. A thin
Playwright-like facade is preferable to exposing every Playwright method initially.

Retain exact URLs, node identity, parent/child relationships, meaningful states,
source document, capture identity and coverage. A flat list without hierarchy
would regress post/image and nested-comment association. Browser handles remain
document/authority-bound; saved data is historical evidence, not a live handle.

`evaluate(fn, jsonArgument)` runs in Chrome, returns JSON and cannot close over
Node variables. It is **not read-only**: it may mutate the page or start network
work. Treat it conservatively as potentially mutating for outcome/retry policy.
Recommend semantic actions for clicks and typing so current actionability and
targeting behavior remain available. Do not build a JavaScript purity detector.

No raw CDP endpoint, unwrapped Playwright browser/context, or CDP escape method is
part of the initial supported API. This limits API scope and accidental misuse;
it is not a security boundary against trusted host code. Add low-level methods
only for concrete missing operations, with their lifecycle implications reviewed.

## Runtime and ownership

One lazy worker and JavaScript namespace per thread browser workspace, hosted on
the Bud machine. Threads share website sign-ins through existing Chrome ownership,
not JavaScript variables or observation stores. The worker attaches to existing
tabs; it never launches a second browser or chooses a profile.

Keep a killable process boundary between generated code and daemon orchestration.
Do not execute generated code in the service process or in a shared helper that
could destroy all threads' state on cancellation. Reuse helper packages/runtime
where practical; keep existing non-REPL viewer and recovery operations working
when a REPL worker is reset.

Authorization remains in the service executor/broker: validate owner against both
Bud and thread, then dispatch with invocation fencing. The daemon binds the cell
to its workspace, connection and control authority. The supported tab facade
lists and accesses only that workspace's owned tabs. Tab IDs are not authority.

Serialize cells within a workspace. Keep current browser-operation serialization
where needed, but do not hold a shared page/media lock while Node performs local
filtering, file IO or arbitrary waits. Track an active cell for takeover admission;
that is distinct from holding the screenshot/page mutex for a whole cell.

General Node imports/files/network are consistent with the trusted terminal model.
Do not inherit provider credentials or unrelated service secrets into the worker.
A VM realm or child process is not an OS sandbox. Agent code could bypass the
facade using host access, just as it could through terminal tools; system guidance
must prohibit using either to evade ownership or private control. Hardening all
host access would be a separate product/security project.

## Private control: coordination contract

Private control means supported agent browser operations are paused and private
viewer/input data is not automatically included in model observations. It does
not promise isolation from arbitrary code with access to the user's machine.

1. Before dispatching a cell, check current authority. If the user owns control,
   reuse durable parking and the inline Return to agent/Cancel UI. Chat and
   non-browser work remain available.
2. A takeover request immediately closes admission to new browser cells across
   the Bud, matching the existing Bud-wide control fence.
3. Let active cells finish and drain tracked browser operations within a bounded
   deadline. During this transition the UI says control is being acquired; do not
   report private control as active early.
4. If the boundary deadline expires, terminate only workers that cannot stop
   cleanly. Never replay their code automatically. Outstanding Chrome-side effects
   may be uncertain.
5. Normal takeover preserves workers and their variables, extracted data and
   helper functions. Invalidate observation/action references and fence pending
   result/image deliveries as control authority changes. Retained data describes
   past observations; it does not grant permission to observe or act during
   private control.
6. On return, require a fresh page observation before resuming interaction.
   Normal takeover/return changes control authority, not the runtime generation;
   emit a reset notice only if a worker actually reset. The parked cell is not
   blindly replayed: reuse the existing replan-after-return behavior with a
   truthful not-executed result when it never started.

Supported API calls require an active cell and valid authority; old retained
facade handles cannot initiate work between cells. The agent must await all
browser operations and avoid timers/background browser loops. Helpers should
track their own outstanding calls so ordinary cell completion is well-defined.
This cannot detect every task scheduled by arbitrary Node or page JavaScript.

Terminating Node does not undo a click, cancel a page's timers, or prove a submitted
request stopped. Page-side work can survive takeover, as ordinary website work
does. Preserve that limitation and uncertain outcomes; do not solve it by
reloading the user's page or destroying the shared browser. The supported flow
is cooperative bounded execution, not adversarial isolation.

## State lifetime and failure semantics

| Event | JavaScript state | Browser state / next action |
| --- | --- | --- |
| Successful cell or normal follow-up turn | Retained | Observe as needed; no automatic full snapshot |
| Ordinary JS exception | Retained; possibly partially changed | Return useful bounded error and partial output |
| Navigation | Bindings retained; old document handles stale | Acquire fresh observation/handles |
| Timeout, running-cell cancellation requiring termination, worker exit | Lost; generation changes | Effects may have happened; inspect before repeating |
| Cancellation of a queued/parked cell | Retained | Cell never executed; no browser effects from that cell |
| Normal private takeover / return | Retained; observation/action references invalidated | User proceeds after acquisition boundary; agent observes afresh on return |
| Service reconnect | Retain if daemon worker survives and is valid | Reconcile durable cell receipt, never resubmit ambiguous code |
| Daemon restart | Lost | Existing browser recovery policy applies independently |
| Workspace close / ownership change | Destroy worker | Existing tab/profile ownership cleanup applies |

Use the existing durable action receipt/idempotency mechanism for cells. A cell
can contain multiple effects, so completed execution is not semantic task success,
and an error after dispatch is not a safe rejection. Retried delivery of a known
cell ID returns its receipt if retained; a missing/uncertain receipt must not
trigger execution again. Do not persist or resume a live JS stack.

Expose a runtime generation with results and a reset reason when it changes.
Model/provider changes do not require resetting local variables. Context
compaction should preserve useful binding names but not promise they exist after
generation changes. Declare the generation on each result; no expensive heap
inventory is needed.

## Output and context

Prefer explicit `repl.write(value)` and `repl.emitImage(bytes)`; do not automatically
print the last expression, which can accidentally dump a full snapshot. Capture
console output too, under the same limit. Emit `(no output)` for silent cells.
Printing huge data is not the way to persist it.

Proposed initial limits, to validate rather than multiply into user settings:

- 30-second cell deadline; supported operations retain shorter bounded deadlines.
- 32 KiB model-facing text budget per cell, plus the existing bounded envelope.
- 1 MiB captured text file ceiling; explicitly mark when even the capture is cut.
- Up to two explicitly emitted images per cell, subject to existing image byte
  and dimension validation. Never print base64 or silently add screenshots to
  the model output.
- A bounded worker heap and internal observation limit; start from measured helper
  limits and raise only where the replay fixture requires it. Model output and
  internal materialization are separate budgets.

The current 32 KiB observation cap must not constrain local filtering to only the
first page of a snapshot. Permit bounded structured materialization in worker
memory (reuse the current retained-tree ceiling initially), or consume existing
frozen pages locally. Always retain truncation/coverage metadata. Do not advertise
full-page extraction when the internal capture itself is partial.

Oversized emitted text gets an explicit truncation marker and an output artifact
identifier/path. Store captured output and optional named JSON checkpoints in a
thread-specific workspace with restrictive permissions. Offer small read/write
helpers so the agent can retrieve slices without another browser action. Keep
exact data on disk when useful; no new database artifact service is needed unless
existing storage cannot support ownership and restart behavior.

Artifacts inherit thread ownership through the authorized invocation. A future
service/UI artifact route must authorize that thread before reading; never serve
arbitrary client-supplied host paths. If new rows are needed, stamp owner/tenant
fields and follow the schema migration workflow. Local filesystem access remains
subject to the trusted-code limitation above.

Persist cell code, bounded emitted results, outcome, timing and artifact references
in existing durable tool history. Large unprinted JS objects are not model input
or automatically archived. Do not log raw page data/URLs in operational diagnostics.
Error details emitted to the model are observations and undergo output bounds and
authority checks; internal logs use safe codes rather than raw page-bearing stacks.

Keep existing conversation compaction; do not introduce aggressive text thinning
in this tranche. REPL execution reduces what enters context, not retention of what
was printed. Later condensation work remains optional based on measurements.

## Viewer integration

Retain user-controlled live media and agent-controlled operation-driven captures.
Supported browser reads/actions mark the viewer capture dirty; coalesce updates
at safe operation/cell boundaries so local extraction loops do not cause one
screenshot per node. Capture at least after browser activity in a completed cell
when a viewer is attached, using existing media authorization. Pure local
filtering needs no new capture. A long cell may have a lagging viewer; keep cells
bounded rather than restoring continuous agent-mode polling.

Viewer frames are separate from model image output. Only explicit image emission
sends an image to the agent, and only while agent observation authority permits it.
On takeover, fence in-flight results/images before delivery. Do not append private
frames or private input to REPL artifacts or transcripts automatically.

## Implementation tranches

### 1. Runtime and observation experiment

Implement isolated per-workspace workers, bindings, explicit output/files, bounded
snapshot access, page evaluation and screenshots. Run controlled extraction tasks
through the actual Bud agent/provider path. Use a development choice of tool
catalog for comparison, not both catalogs in the same agent request.

This experiment must already honor ownership, cancellation and private control;
it is not permission to ship a bypass while testing context savings.

### 2. Complete browser operations and handoff

Expose the existing semantic/navigation/tab operations through the facade. Wire
durable cell receipts, takeover draining with memory preservation, exceptional
worker termination, return-to-agent replan, restart notices and viewer capture.
Verify mixed read/action cells and partial failures.

### 3. Coordinated tool cutover

Advertise browser REPL support through an explicit daemon capability. Upgrade the
daemon/helper and service together; fail clearly when the required add-on is
missing or stale. Remove the old model-facing open/observe/act/close catalog once
acceptance passes; retain implementation functions needed by the facade/viewer.
Historical tool rows still render/replay as history, without legacy executable
aliases. Keep the existing handoff tool.

Rebuild daemon, prepare the matching helper using managed Node, and restart the
daemon/runtime for activation. Service tool schemas/guidance upgrade with it.
Web/mobile need only acquisition/reset presentation changes if current state
contracts cannot express them. Document any protocol changes in `docs/proto.md`;
do not invent a new transport alongside the existing broker.

## Validation and affected documentation

Compare against the current tools on fixed virtualized-feed/comment fixtures and
real-agent tasks: count the tenth non-ad post; open the correct post rather than
its image; summarize nested comments; answer a detail follow-up from saved data;
handle changed pages, long exact URLs, iframes and partial coverage.

Measure provider actual input/output/cache usage, peak context, total model/tool
calls, duration, repeated observations and correctness. Include generated code and
errors in context cost. Do not infer savings from one successful extraction cell.

Lifecycle tests cover concurrent threads, wrong-owner/workspace access, takeover
during a cell, timeout after a mutation, worker crash, service receipt recovery,
daemon restart, lost bindings, stale handles, and post-takeover output fencing.
Verify normal takeover/return preserves variables, extracted data, helper
functions and runtime generation while invalidating old action references.
Forced termination must change the generation; canceling an unstarted cell must
not discard worker memory.
Verify no automatic mutation replay, orphaned tool results, deadlocked media locks,
or private viewer content entering model output. Test output truncation and
artifact recall separately from live browser observation.

Update helper, daemon browser, agent, service browser and relevant runtime/LLM
specs when implemented; update protocol/client docs if their contracts change.
Follow the linked implementation plan before coding. No schema migration is
assumed by this scope.

## Decisions and remaining implementation checks

Settled direction: trusted Node code, one worker per thread workspace, existing
Chrome/profile ownership, explicit bounded output, semantic action reuse,
standalone durable handoff, and no new browser memory/compaction subsystem.
Normal private takeover preserves REPL memory. Reset only when execution cannot
stop cleanly or the worker's lifetime ends; existing daemon restart and workspace
destruction rules still apply.

Phase 1 settled the internal bridge, durable receipt integration, takeover deadline
and initial measured worker memory limit. Phase 2 implements the typed observation facade and bounded artifacts.
Keeping an idle worker alive requires no heap checkpoint or suspended-cell recovery
system. Rebuild bindings only after an actual reset.

Stronger isolation from malicious generated code would require a separate design
covering terminal execution and the whole machine-access boundary. It is not an
implicit promise or prerequisite of this REPL feature.
