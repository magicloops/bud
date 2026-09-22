# Design: Simple agent request building

Status: scoped; not implemented.
Date: 2026-09-16.

## Problem

Tool discovery currently depends on execution hooks and browser execution context.
The context meter reuses that logic without a running invocation. The recent
refactor omitted invocation identity, causing browser availability to return false
and removing browser tools from actual provider requests.

The immediate regression is fixed, but `getContextTools(..., hooks?)` still uses
missing hooks to mean an idle preview. Request preparation also repeats across
pre-turn compaction, model steps and durable context reconstruction.

See the [current implementation review](../review/agent-tools-and-context-building.md)
and [regression evidence](../debug/browser-tool-catalog-invocation-regression.md).

## Objective

Use three clear responsibilities:

1. **Build the request:** reconstruct messages and select tools from configuration
   and the owned Bud's capabilities.
2. **Measure that request:** meter and compaction consume those same prepared inputs.
3. **Authorize execution:** when a tool is called, validate arguments, ownership,
   invocation authority and current resource state before any side effect.

Invocation IDs, worker fences and parking callbacks belong to execution. Building
a tool list must not require them or manufacture substitutes.

## Proposed structure

```text
owned thread + selected model + loaded conversation + capability facts
                            |
                     prepare request
                            |
                    { messages, tools }
                     /             \
          budget / compaction      provider invocation
                                          |
                                      tool call
                                          |
                              authorize and execute / park
```

Keep the existing canonical messages, tool schemas, provider adapters, conversation
loader and accounting resolver. Add only a small shared preparation function and
an explicit set of capability facts; do not introduce a request-builder class or
another orchestration layer.

### Capability discovery and catalog selection

Collect read-only facts after resolving the owning thread/Bud:

- Which service features and executors are configured, including durable approval
  and continuation support.
- Whether the Bud is online and advertises the relevant browser capabilities.
- Whether public web retrieval is configured and available.

Pass those facts to the existing pure tool-selection function. The selector does
not receive `AgentExecutionHooks`, `BrowserAgentContext`, an abort controller, or
an invocation identity. Return the existing canonical tool array in stable order.

Distinguish a **configured execution capability** from a **currently held lease**.
For example, a service without durable approval support must omit approval tools;
that fact comes from composition/configuration, not from examining a particular
turn's parking callback. Keep supported execution entry points consistent with
those advertised capabilities. Unsupported legacy entry points must not advertise
functions they cannot service, but do not create fake invocations to handle them.

Temporary browser private control does not remove ordinary browser tools. Their
calls use the existing durable return-control waiting path. Optional handoff support
still requires its configured/capability support; decisions about whether a specific
handoff is appropriate or already pending remain in the existing execution path.
Do not acquire a lease, create a browser session or dispatch a command to discover
capabilities. Do not add a second permissions or policy registry.

### One preparation function

The function accepts an already-loaded canonical conversation, current environment
and resolved tool capabilities. It applies runtime instructions and resolves the
tool list, returning `{ messages, tools }` without modifying stored history.

The loader remains responsible for checkpoints, native replay, model visibility,
provenance and orphan repair. Model selection remains in the existing resolver.
Do not fold those subsystems into a new monolithic builder.

For each normal model step:

1. Check the existing execution lease/cancellation boundary.
2. Resolve current environment/capabilities and prepare messages/tools once.
3. Compute the budget from that prepared input and compact if needed.
4. If compaction replaced history, prepare again from the replacement, then measure
   and capture the baseline for the request that will actually be sent.
5. Pass those same messages/tools to the model runner.

This replaces the duplicated pre-turn/mid-turn request assembly. Preserve existing
compaction boundary suppression, output reserves, thresholds and overflow recovery.
The provider-overflow retry must also rebuild and measure the replacement input;
it must not reuse a pre-compaction baseline.

Treat the prepared object as fixed for that provider request. It contains request
content, not an authorization snapshot. A Bud may disconnect immediately afterward;
execution-time checks still decide whether the returned tool call can run.

### Meter and model-view routes

After the existing viewer/thread authorization, idle reads use the same preparation
function with reconstructed history and current capabilities. There is no special
preview invocation or preview execution hook set.

During a turn, retain the active budget snapshot from the actual prepared request.
Idle reconstruction describes the request that would be prepared now, not a stored
byte-exact copy of the last request. Capability or history changes can legitimately
invalidate its provider usage anchor. Preserve the existing source/stale provenance.

Keep model-view source labels aligned when runtime messages are inserted. Share the
insertion logic between ordinary preparation and preparation with provenance;
avoid maintaining two independent placement algorithms.

### Execution authority remains unchanged

Worker hooks continue to renew leases, record action intent, park human waits and
commit results. Browser/tool executors retain argument validation and ownership
checks. Browser repository admission still verifies the real invocation, worker,
fence, turn, lease, cancellation and action receipt. Daemon generation/control
checks and evidence checks remain in place.

Tool advertisement is neither permission to execute nor proof the resource is
still available. Unknown or unsupported calls must be rejected through the existing
validation path. Removing invocation-dependent discovery must not bypass any of
these execution checks.

## Cleanup included

- Remove the optional-hook preview/execution branch from `getContextTools`.
- Remove execution-context construction used only for catalog discovery.
- Consolidate normal-step messages/tools preparation and duplicate runtime-message
  insertion; migrate the agent loop, idle budget and model-view consumers together.
- Retire the static normal-agent tool-token shortcut/default where it can silently
  substitute a smaller catalog for the resolved tools. Retain unrelated provider
  or summary-call defaults only when they are intentional and explicit.
- Update the catalog regression test to exercise the simpler input contract with
  real capability discovery, rather than retaining tests of removed hook branching.

Do not retain unused compatibility wrappers around replaced internal helpers.

## Edge cases and acceptance criteria

| Case | Required behavior |
| --- | --- |
| Capable online Bud, idle thread | Browser catalog can be built with no invocation |
| Same facts during execution | Same messages/tools and budget as idle preparation, given the same loaded history/model |
| Offline/incapable Bud | Device tools omitted; configured service retrieval remains available |
| Durable approvals not configured | Approval tools omitted without consulting turn callbacks |
| Human holds private browser control | No discovery-side takeover; a browser call parks through the existing path |
| Capability/control changes after preparation | Execution revalidates; no stale authority or automatic mutation replay |
| Cancel or lease loss | Existing checkpoint/dispatch checks prevent further work |
| Compaction or overflow retry | Rebuild from replacement history; baseline describes the actual next request |
| Model/provider/reasoning change | Existing replay compatibility and anchor invalidation apply |
| Browser screenshots | Existing just-in-time hydration and conservative accounting fallback remain |
| Concurrent input / persisted-history differences | Preserve model-visibility ordering and strict prefix validation; do not add an alignment engine |
| Signed-in foreign viewer | Existing 404 boundary before history/capability reads; unauthenticated reads remain 401 |

## Validation

Test behavior rather than prompt vocabulary:

- Catalog matrices for online/offline/incapable Buds and configured service features.
- A real broker/capability fixture showing browser tools in idle and live preparation
  without any catalog input containing an invocation; discovery dispatches nothing.
- Parity of prepared messages/tools for loop and idle consumers under equal inputs,
  including runtime-instruction placement and provenance.
- Compaction/retry tests checking the request sent and baseline captured are the
  same replacement input, with unchanged compaction policy.
- Existing execution tests proving missing/stale leases, foreign ownership and
  private control still reject or park before side effects.
- One local agent browser run using the prior Hacker News prompt, followed by idle
  meter/model-view reconstruction. Confirm browser tools were advertised and used;
  do not treat an isolated model choice as a deterministic catalog test.

No new full-prompt logging is required. Use test fixtures and existing bounded
metadata; if investigation needs visibility, inspect tool names rather than page
contents, credentials or entire provider requests.

## Won't-dos

- No new tool registry, plugin framework, generic authorization engine or scheduler.
- No fake invocation identities, preview leases or stored permission grants.
- No provider adapter rewrite, tool renaming, prompt rewrite or forced browser choice.
- No browser lifecycle/media changes, tokenizer, compaction policy change or new
  usage-calibration system.
- No new tables, request archives, endpoints, background reconciliation or per-token
  meter updates.
- No promise of atomicity across DB, daemon and provider; authority stays checked at
  execution, and idle request reconstruction stays explicitly a current view.

## Implementation boundary and rollout

Implement as one coherent service refactor, migrating all three request consumers
and deleting the superseded paths in the same change. Keep the public context-budget
shape, tool argument/result contracts and owner stamping unchanged.

Primary files: `agent-service.ts`, `environment.ts`, `tool-definitions.ts`, the small
new preparation helper, browser availability helpers, `context-budget-snapshot.ts`
and the thread agent/model-context routes. Update agent/browser/thread specs and
relevant tests. Update LLM specs only if an internal call signature changes there.

No DB migration or daemon upgrade is needed. New service/old daemon uses existing
capability gates; old service/new daemon behaves as before. Web/mobile consume the
existing snapshot fields. This design does not authorize removing deploy-order or
ownership protections.
