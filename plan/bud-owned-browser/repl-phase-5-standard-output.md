# Phase 5: Standard REPL output and selective-evidence guidance

Status: implemented; automated validation and controlled provider comparison recorded
in [Phase 5 validation](../../debug/browser-repl-phase5.md). Live product/high-effort
thread and physical viewer acceptance remain. 2026-09-23.

## Context and objective

Follow-up to [the REPL implementation plan](repl-implementation.md), especially
Phase 4, and [the live 8b60 review](../../debug/browser-repl-8b60-review.md).
That run completed successfully but expanded eight of ten output budgets and
recovered oversized results by printing raw artifact prefixes. Five broad outputs
accounted for 89.5% of its inline text. The runtime controls worked; they did not
ensure useful selection by the agent.

Bring Bud's text interaction closer to the inspected browser-use Pi environment:
standard console output plus the evaluator's final non-undefined result. Keep
selection as ordinary agent-authored JavaScript. Do not build comment extraction,
site-specific recipes, a generic extraction DSL, or another browser engine.

Reference checkout: `/Users/adam/code/browser-use-pi/src/worker.ts` and
`src/prompt.ts`; its [local review](../../../code/browser-use-pi/review/context-and-compaction.md)
describes console/final-value output, selected observations and later compaction.
The checkout is supporting evidence, not a portable repository dependency.
Bud's current worker already captures console output but discards the evaluator
callback's result. This phase changes that behavior using the existing Node
REPL evaluator, not Pi's inspector implementation.

## Settled scope

- Remove `repl.write` altogether. No deprecated alias, compatibility flag or
  second text-output API. Update executable examples, tests and agent guidance.
  Historical transcripts/measurement reports remain faithful to the old API.
- Capture console output and automatically display a successful cell's final
  non-undefined value through one bounded text-output path.
- Replace the current verbose output instructions with short, general guidance
  and a few accurate examples of retaining, selecting and inspecting data.
- Keep the current browser facade, ownership checks, image emission, artifacts,
  execution receipts and viewer lifecycle. Do not expose raw CDP or unwrapped
  Playwright merely to copy the reference implementation.
- Keep the 8 KiB default, explicit 32 KiB ceiling, 1 MiB capture and current file
  retention for this experiment. Do not introduce a new budget policy, remove
  expansion, add history thinning or alter compaction in the same comparison.

This is a refinement of Phase 4's output behavior, implementable before its
remaining production catalog cutover. It does not mark the lifecycle, coverage
or efficiency acceptance gates complete.

## Output contract

1. Evaluate each cell exactly once with the existing managed Node REPL.
   Capture the actual evaluation completion value; do not parse or rewrite the
   source, append a return, or execute the final expression a second time.
2. Console calls emit in execution order. After evaluation and supported-operation
   draining, append one final value when evaluation succeeded and that value is
   not `undefined`. Preserve existing error/uncertain-effect handling: logs before
   a failure survive, but no successful final value is appended for a failed cell.
3. `console.log(...)` itself returns undefined, so a cell ending in that call
   does not echo the printed value again. If the code deliberately logs a value
   and then evaluates it, both emissions are shown; no heuristic deduplication.
4. Print false, zero, empty string and null. Undefined/declarations yield no
   automatic output. Use native completion semantics: assignment expressions and
   block completions can produce values; a trailing semicolon does not suppress
   them. Teach `var saved = await ...` or an explicit final `void 0` for silence.
5. Console messages and final values share one formatter/budget/artifact path.
   Honor standard multiple-argument console formatting. Use Node's bounded
   inspection facilities for objects, cycles, BigInt and non-JSON values;
   getters and custom inspection hooks must not be deliberately invoked.
   Do not enumerate asynchronous/browser properties or fetch additional data
   to display a handle. Formatting must not replay an action.
6. Inspection is a readable preview, not a JSON transport. Document any depth,
   array or string elision and use finite limits. Select concrete fields for
   exact evidence; `console.log(JSON.stringify(selected))` is available when an
   exact JSON representation is needed. A saved formatted capture is not
   necessarily JSON and may itself be incomplete; never promise otherwise.
7. Preserve complete-emission overflow: keep preceding emissions, omit the
   overflowing and subsequent emissions, and return the existing artifact and
   truncation metadata. Automatic output uses exactly the same rules. Output
   size alone does not turn a completed action into failure. Handle formatting
   failures with bounded diagnostic output without hiding possible side effects.
8. Final screenshot buffers/typed arrays must not dump image bytes. Give a short
   type/size notice directing the agent to `repl.emitImage`; do not implicitly
   upload an image. Explicit image count, validation and authority gates remain.
9. Final output is attributed to the active cell before it closes. Late timers,
   callbacks or lost authority cannot publish into a later cell. Reuse the
   existing delivery fence; final-value handling must not create an early result
   path before tracked operations drain.

Implementation should settle finite inspection options in the worker and document
those values. Avoid a custom serializer or object traversal framework. Ordinary
trusted Node code remains trusted code; these formatting defaults are not a
sandbox guarantee for malicious objects/proxies.

## Agent-facing guidance

Use one coherent description in the existing tool catalog and argument-error
help. Remove “final expressions are silent” and all active `repl.write` recipes.
Do not add a second prompt document that duplicates the API description.

Proposed core wording:

> JavaScript runs in a persistent Node REPL. Variables and top-level await survive
> cells. Console output and the final non-undefined value become tool output.
> Store large observations in variables; return or log only evidence needed for
> your next decision. Use the accessible snapshot for discovery and evaluate for
> focused DOM extraction. After overflow, select from retained data or inspect
> the saved capture locally; do not print arbitrary file prefixes or repeat
> completed browser actions. Expand the output budget only when selected relevant
> evidence needs it. Preserve source identity, exact URLs, relationships and
> coverage; samples and unloaded content are not complete reads. Verify mutations
> against observed state and do not replay uncertain actions.

Examples should use the real Bud facade, not browser-use method names:

```js
// Retain a capture locally; the declaration has no displayed result.
var tab = await browser.tabs.current();
var snapshot = await tab.snapshot();
```

```js
// Display a small selected value using the final expression.
({ coverage: snapshot.coverage, limitations: snapshot.limitations,
   headings: snapshot.nodes.filter(n => n.role === 'heading')
     .map(n => ({ depth: n.depth, name: n.name, text: n.text })) })
```

```js
// Explicit logging is useful for multiple observations within a cell.
console.log(await tab.info());
console.log('Captured nodes:', snapshot.nodes.length);
```

Retain concise documentation of `nodes`, flat pre-order subtree boundaries,
reference freshness, function argument passing, reset behavior, exact artifact
paths and private handoff. Teach checking assumptions before filtering (including
missing boundaries and relative URL bases). These are general data correctness
rules, not post/comment-specific algorithms. Do not claim the output API change
alone will make agent extraction more efficient.

## Ownership and impacted contracts

The authenticated service resolves the owning thread/Bud/invocation before
execution; the daemon checks workspace and current authority for every supported
browser operation and before output delivery. These remain unchanged. No new
browser-facing route, stream, DB table, owner stamping or migration is required.

`browser_exec({code})` and existing result fields remain unchanged. The deliberate
breaking change is the JavaScript runtime API and meaning of successful cell
output. Preserve durable receipts: historical code is displayed, never executed
again to translate output. Keep `repl.files`, `repl.setOutputBudget` and
`repl.emitImage`; removing `repl.write` does not require renaming that namespace.

## Implementation checklist and documentation

- [x] Worker: expose completion values, consolidate formatting/capture and remove
  `repl.write`; retain the existing evaluator and lifecycle fences.
- [x] Agent: update tool description and invalid-argument help together; simplify
  examples without adding prompt-vocabulary assertion tests.
- [x] Update executable worker/daemon/service fixtures and the comparison harness
  where they invoke the removed method. Preserve historical reports unchanged.
- [x] Update [helper spec](../../bud/browser-helper/browser-helper.spec.md), helper
  README, [agent spec](../../service/src/agent/agent.spec.md), affected
  [daemon spec](../../bud/src/browser/browser.spec.md) and
  [service browser spec](../../service/src/browser/browser.spec.md) as appropriate.
- [x] Update [design](../../design/browser-repl.md), parent plan and helper output semantics.
  The existing wire result fields and limits in [protocol](../../docs/proto.md)
  are unchanged; this changes the JavaScript API and text contents only.
  Update scripts spec for the optional comparison reasoning setting. Label prior
  explicit-only semantics as superseded.

## Validation and acceptance

Focused worker tests: primitive/object/awaited results, declaration and undefined
silence, console ordering/no accidental duplicate, assignment/block semantics,
cycles/BigInt, bounded preview elision, image buffers, Unicode/shared budgets,
overflow artifact recall, ordinary exceptions, formatting failure, tracked
unawaited calls and late callbacks. Verify a mutation returning a value executes
once even when formatting overflows. Assert `repl.write` is absent.

Run focused daemon/service receipt, private-control, image and replay regressions.
Confirm final output crosses the real service path without being duplicated in
model context. Ordinary output changes must not trigger viewer reconnects.

Repeat fixed-fixture selective lookup, table/article reading and form verification
with the same model, effort, task inputs and repetitions as the baseline. Record
correctness, coverage, actual provider usage, peak context, emitted bytes,
overflows/expansions, calls and duration. Include a live run at the high reasoning
setting used in 8b60. Judge arbitrary prefix reads and repeated broad outputs as
remaining problems even if all API calls succeed. No invented savings target;
report regressions and do not change compaction to mask them.

## Coordinated activation

Drain active cells, rebuild the daemon archive, prepare its matching helper,
update the service guidance and restart the affected daemon/workers together.
No long-lived mixed-version bridge or `repl.write` alias is planned. Existing
threads retain transcript history, but worker restart loses JavaScript bindings;
current runtime metadata tells the agent to reacquire handles and observe.

No web/mobile build is expected solely for these unchanged result fields. Test
existing viewer/private-control behavior and retain the parent plan's outstanding
physical-device acceptance. Implementation does not deploy, restart, commit or remove the old production
tool catalog.


Phase 7b supersedes only the whole-overflowing-emission omission rule: the shared
collector now includes a clearly labeled incomplete excerpt when space remains.
Native completion/console, bounded artifacts, execution and authority semantics
stay intact. See [Phase 7b](repl-phase-7b-output-compaction.md).
