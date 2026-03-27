# mobile-agent-stream-attach-semantics

Implementation planning documents for separating passive thread-open semantics from reconnect replay in the agent stream.

## Purpose

This folder turns the design review in [../../design/mobile-agent-stream-attach-semantics.md](../../design/mobile-agent-stream-attach-semantics.md) into an actionable implementation and validation plan.

The current plan assumes:

- the stale mobile behavior is caused by real backend attach-time replay semantics
- the clean fix is to add an explicit current-turn snapshot route instead of relying on buffered SSE replay for bootstrap
- the fresh-attach semantics change should apply to the agent stream specifically, not silently to every SSE route
- replay should be only a bounded catch-up window, not history
- stale or unknown resume cursors should produce explicit server-owned resync behavior
- the current single-instance prototype architecture remains the deployment model for this work

## Files

### `implementation-spec.md`

Parent implementation spec for the agent-stream attach-semantics work.

Documents:

- the current contract problem
- the chosen runtime-snapshot plus bounded-resume/live-only-attach direction
- phase sequencing
- risks and definition of done

### `phase-1-runtime-snapshot-foundation.md`

Backend foundation phase covering:

- service-owned current-turn snapshot state
- authorized `GET /api/threads/:thread_id/agent/state`
- lifecycle tracking for tool, draft, and final states
- opaque resume-token semantics and cursor invariants
- backend spec updates

### `phase-2-reference-web-adoption.md`

Reference-web adoption phase covering:

- thread-open bootstrap from `/messages` plus `/agent/state`
- use of `stream_cursor` during attach
- removal of dependence on stale fresh-attach replay for bootstrap
- explicit server-owned resync handling instead of client-led gap repair

### `phase-3-live-only-attach-and-handoff.md`

Contract-flip and documentation phase covering:

- live-only no-cursor attach for the agent stream
- bounded cursor replay preservation
- explicit `resync_required`
- fixture and protocol updates
- final handoff and validation work

### `progress-checklist.md`

Running implementation checklist for the plan.

Covers:

- backend runtime snapshot progress
- reference-web adoption
- stream semantics flip
- doc and fixture follow-through

### `validation-checklist.md`

Manual verification checklist for the plan.

Covers:

- runtime-state route behavior
- completed-thread reopen
- active-turn open
- reconnect replay semantics
- docs/spec alignment

## Dependencies

- [../../design/mobile-agent-stream-attach-semantics.md](../../design/mobile-agent-stream-attach-semantics.md) - design review and recommended contract
- [../../reference/IOS_AGENT_STREAM_ATTACH_SEMANTICS_HANDOFF.md](../../reference/IOS_AGENT_STREAM_ATTACH_SEMANTICS_HANDOFF.md) - mobile-reported problem statement
- [../mobile-api-simplify/phase-2-agent-stream-contract.md](../mobile-api-simplify/phase-2-agent-stream-contract.md) - prior completed stream-contract cleanup that this plan builds on
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This folder plans a single-instance, process-local runtime snapshot only. Durable multi-instance replay/state remains intentionally out of scope for this pass.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
