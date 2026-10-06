# Phase 2: Cheap state and independent context budget

Status: Service and web implemented; auth, cheap-state and budget hook tests pass.
Request: F2. Native adoption/physical acceptance pending.

## REST contracts

`GET /api/threads/:threadId/agent/state` remains the runtime/durable pending
snapshot but no longer reconstructs model context. It may include a known
applicable `context_budget`; omit the property when none is available.
An omitted property means “no update”, not “clear the meter”.

`GET /api/threads/:threadId/open` retains its existing fields and pre-read runtime
cursor boundary. Include the same applicable known budget in `agent_state`;
set `included.context_budget:true` iff the property is supplied, including an
explicit unknown snapshot. This flag means supplied, not fresh/available.
Keep browser/web-view inclusion unchanged. No idle reconstruction on either route.

Add `GET /api/threads/:threadId/context-budget`, authorized using the same owned
thread helper before any environment/tools/conversation lookup. Response:
`{ "context_budget": <existing ContextBudgetSnapshot> }`, `Cache-Control:no-store`.
Prefer a compatible active decision; otherwise call the existing reconstruction
implementation. Preserve its unknown/error semantics and source/freshness fields.
Do not add transcript, pending inventories, stream cursors or runtime overlays.
No query mode that makes `/open` secretly perform this expensive read.

In this phase, “known” means applicable runtime budget, not a new idle cache.
Before supplying it, validate that model/reasoning context matches the intended
display; preserve turn identity and stale status. If applicability cannot be
established cheaply, omit it and use the dedicated endpoint. Phase 4 optionally
extends known snapshots to reusable idle state.

## Service and clients

Split the context reconstruction branch from `state-loader.ts`; share cheap
state loading between open and agent/state. Retain environment and all pending
inventories. Move independent bounded DB reads to parallel execution only where
ownership/order permits; cheap does not mean an atomic snapshot or a fixed SLO.

Update web `use-context-budget` and all full-state call sites. On mount, accept
a usable included snapshot; otherwise fetch the budget endpoint after chat paints.
Explicit model changes, final/cancel transitions and relevant compaction changes
refresh the meter independently of state. Coalesce overlapping reads, abort on
owner/thread change, and prevent older requests overwriting newer live values.
Retain known values on transient errors, displaying stale/unknown honestly.
Mobile adopts the same rules; unknown snapshots must not cause retry loops.

Cheap state requests used for targeted reconciliation do not adopt their cursor
or overwrite newer stream-owned drafts/activity. Full stream recovery continues
to use `/open` and the established bootstrap boundary.

## Acceptance

- [ ] Spy/integration tests prove open/state do not call context reconstruction,
      load transcript for budgeting or count tokens on cold/idle threads.
- [ ] Dedicated endpoint retains accounting parity with current implementation,
      including provider anchors, compaction, active decisions and unknown models.
- [ ] Unauthorized/foreign owner cannot reach reconstruction.
- [ ] Web mount with usable included budget makes zero budget requests; cold
      mount makes one independent request and paints chat without waiting.
- [ ] Thread/owner switches, overlapping reads and newer live snapshots cannot
      apply obsolete budget or agent state.
- [ ] Fixtures document omitted, unknown, stale and available values; coordinated
      mobile adopter no longer expects reconstruction from `/agent/state`.

No schema migration. Roll out service and both clients together; the changed
state semantics are intentionally not a permanent compatibility mode.
