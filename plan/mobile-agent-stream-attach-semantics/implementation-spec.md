# Implementation Spec: Mobile Agent Stream Attach Semantics

**Status**: Draft
**Created**: 2026-03-26
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-runtime-snapshot-foundation.md](./phase-1-runtime-snapshot-foundation.md)
**Phase 2**: [phase-2-reference-web-adoption.md](./phase-2-reference-web-adoption.md)
**Phase 3**: [phase-3-live-only-attach-and-handoff.md](./phase-3-live-only-attach-and-handoff.md)
**Related Docs**:
- [../../design/mobile-agent-stream-attach-semantics.md](../../design/mobile-agent-stream-attach-semantics.md)
- [../../reference/IOS_AGENT_STREAM_ATTACH_SEMANTICS_HANDOFF.md](../../reference/IOS_AGENT_STREAM_ATTACH_SEMANTICS_HANDOFF.md)
- [../mobile-api-simplify/phase-2-agent-stream-contract.md](../mobile-api-simplify/phase-2-agent-stream-contract.md)

---

## Context

The new iOS handoff surfaced a concrete backend contract problem around `GET /api/threads/:thread_id/agent/stream`.

Current shipped behavior is:

- fresh attach without `Last-Event-ID` replays the entire current in-memory agent buffer for that thread
- the agent buffer is cleared at the start of the next turn, not immediately after `final`
- a completed thread can therefore reopen into a transient fake-active state if the process still has the prior turn buffered

That behavior conflicts with how mobile needs to use the backend:

- `/messages` is the durable transcript baseline
- fresh SSE attach should be additive unless the client explicitly asks for resume replay
- active-turn bootstrap should be explicit, not inferred from old buffered frames

The design review in [../../design/mobile-agent-stream-attach-semantics.md](../../design/mobile-agent-stream-attach-semantics.md) recommends separating those concerns:

1. add an explicit best-effort current-turn snapshot route
2. make cursorless agent-stream attach live-only
3. keep buffered replay only for explicit cursor-based recovery

Follow-up review tightened that direction further:

- state should be the authoritative runtime surface
- the stream should be transport, not history
- replay should be only a bounded catch-up window
- resume failure should be explicit server-owned `resync_required`, not client-led gap repair

## Objective

Implement a simpler and more robust thread-open/runtime contract for web and iOS by:

1. adding `GET /api/threads/:thread_id/agent/state` as the explicit current-turn bootstrap surface
2. updating the reference web client to consume that route on thread open
3. making `stream_cursor` an opaque monotonic resume token owned by the server
4. changing `GET /api/threads/:thread_id/agent/stream` so no-cursor attach is live-only and cursor attach is only a bounded catch-up window
5. making resume failure explicit through a server-owned `resync_required` contract
6. preserving a simple recovery path of refetching `/messages` plus `/agent/state`
7. aligning docs, fixtures, and tests with the shipped behavior

This is not a mobile-only fork. The goal is one cleaner contract that both web and iOS can use.

## Why This Matters

Today the product splits "current truth" across three layers:

- persisted canonical transcript rows in `/messages`
- process-local agent replay buffers
- client-local transient draft/tool rows

Using historical buffered frames as the only bootstrap mechanism mixes two different jobs:

- gap fill after reconnect
- current-turn state bootstrap on thread open

That coupling makes passive reopen unstable and keeps the contract hard to explain.

The simplest long-term direction is:

- `/messages` remains durable truth
- `/agent/state` exposes explicit ephemeral runtime state
- `/agent/stream` is live transport with only bounded resume support

## Architecture Phrase

State is truth. Stream is transport. Messages are history. Replay is only a reconnect convenience.

## Success Criteria

- [ ] `GET /api/threads/:thread_id/agent/state` exists and is ownership-aware.
- [ ] the route returns a best-effort runtime snapshot with `active`, `turn_id`, `phase`, `stream_cursor`, `pending_tool`, and `draft_assistant` fields.
- [ ] `stream_cursor` is an opaque monotonic resume token that exists before the first emitted event of an active turn and is present on idle snapshots too.
- [ ] `/agent/state.stream_cursor` and the agent-stream SSE frame `id:` share the same cursor space.
- [ ] `AgentService` maintains and clears runtime snapshot state across success, failure, and cancellation paths.
- [ ] the reference web thread route loads `/messages` plus `/agent/state` on open and uses `stream_cursor` when attaching SSE.
- [ ] a snapshot with cursor `C` includes all runtime effects up to `C`.
- [ ] `GET /api/threads/:thread_id/agent/stream` with a supplied cursor either delivers only effects after `C` or explicitly returns `resync_required`.
- [ ] `GET /api/threads/:thread_id/agent/stream` keeps replay bounded to a small catch-up window instead of acting like history.
- [ ] no-cursor agent-stream attach is live-only.
- [ ] passive open of a completed thread no longer flashes fake running-tool or stop-button state.
- [ ] active-turn open still shows current draft/tool/runtime state without relying on stale replay.
- [ ] runtime snapshot does not reset to idle until final durable state is available and the resume token has advanced past that completion boundary.
- [ ] terminal-stream semantics remain unchanged unless a separate plan explicitly revisits them.
- [ ] docs, fixtures, specs, and validation notes all describe the same contract.

## Design Anchors

These decisions are fixed for this plan:

- Keep the existing thread route family rather than inventing mobile-only endpoints.
- Treat `GET /api/threads/:thread_id/messages` as the durable transcript source of truth.
- Treat `GET /api/threads/:thread_id/agent/state` as a best-effort, process-local runtime snapshot, not a durable history surface.
- Treat `GET /api/threads/:thread_id/agent/stream` as live continuation by default, not as history.
- Treat `stream_cursor` as a server-owned opaque monotonic resume token, not just "latest emitted SSE id when one exists."
- Treat `/agent/state.stream_cursor` and agent-stream SSE frame `id:` as one shared resume-token space.
- Keep replay bounded to the race between `/agent/state` and `/agent/stream` plus short reconnects.
- A snapshot with cursor `C` must include all runtime effects up to `C`.
- `/agent/stream` after `C` must either deliver only effects after `C` or explicitly require resync.
- Native/mobile clients should use `after=<cursor>` as the single client-managed resume carrier rather than mixing multiple resume channels.
- Do not rely on client-side gap detection and repair as the primary model.
- Scope the live-only fresh-attach change to the agent stream; do not silently change terminal or run stream semantics in the same pass.
- Continue authorizing before any browser-facing stream attach or runtime-state read.
- Treat same-instance continuity as the current scope unless we deliberately add shared ephemeral storage later.

## Priority Summary

### Urgent

- backend runtime snapshot store and route
- opaque resume-token semantics
- bounded agent-stream catch-up plus explicit `resync_required`
- reference-web adoption so the semantics flip does not regress active-turn open
- explicit fixtures/tests for passive open, active-turn open, and reconnect recovery
- explicit client-facing rules for runtime overlay projection, `/agent/state` failure fallback, and non-destructive `agent.resync_required` recovery while detached

### High

- doc alignment across protocol, specs, and iOS handoffs
- clear handling of success, failure, and cancel paths in the runtime snapshot

### Medium

- optional temporary rollout gate if we decide the semantics flip needs one
- extra runtime metadata only if web/iOS proves it is necessary

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 1 | [phase-1-runtime-snapshot-foundation.md](./phase-1-runtime-snapshot-foundation.md) | Urgent | Service owns an explicit current-turn snapshot model, durable cursor invariant, and authorized `/agent/state` route |
| 2 | [phase-2-reference-web-adoption.md](./phase-2-reference-web-adoption.md) | Urgent | The reference web thread view consumes `/agent/state`, attaches with snapshot cursors, and treats resync as a server-owned path |
| 3 | [phase-3-live-only-attach-and-handoff.md](./phase-3-live-only-attach-and-handoff.md) | Urgent | Agent-stream attach becomes live-only by default, resume becomes bounded and explicit, and the docs/fixtures/tests align with the shipped contract |

## Sequencing Notes

- Do not flip agent-stream fresh-attach semantics before the reference web client can bootstrap from `/agent/state`.
- Do not implement the semantics change by globally changing `SseEventBus` behavior for every stream type.
- Keep the runtime snapshot and stream-cursor tracking in the same service branch so snapshot bootstrap and live attach can be validated together.
- Keep the resume-token invariant and the `resync_required` path explicit before touching the client reconnect flow.
- Ship doc and fixture updates with the contract change, not as follow-up cleanup.
- If rollout risk proves higher than expected, use a temporary compatibility gate only as a transition tool, not as part of the final contract.
- If production-grade cross-instance continuity becomes a near-term requirement, move the snapshot plus catch-up window into shared ephemeral storage rather than pushing more repair logic into clients.

## Expected Files And Areas

### Service

- `service/src/routes/threads.ts`
- `service/src/agent/agent-service.ts`
- `service/src/runtime/event-bus.ts`
- `service/src/runtime/event-bus.test.ts`
- `service/src/runtime/` for any new runtime-state helper module
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/src.spec.md`

### Web

- `web/src/routes/$budId/$threadId.tsx`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/components/workbench/workbench.spec.md` if behavior notes move there

### Root Docs And Fixtures

- `docs/proto.md`
- `reference/IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md`
- `reference/IOS_AGENT_STREAM_STATE_AND_RESUME_FIXTURES.md`
- `bud.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| We change shared event-bus semantics and accidentally regress terminal-stream attach behavior | Medium | High | Keep the attach-policy change agent-stream-specific and add targeted tests |
| Runtime snapshot state drifts or stays active after `final` | Medium | High | Track all success/failure/cancel exit paths and test idle reset explicitly |
| Snapshot fetch and SSE attach race leaves a visible gap | Medium | Medium | Include `stream_cursor` in `/agent/state` and attach with that cursor immediately |
| Cursor semantics are too weak to cover “active, no first event yet” | Medium | High | Make `stream_cursor` monotonic and allocate it before the first visible event of a turn |
| Process-local runtime snapshot gets mistaken for durable truth | Medium | Medium | Document `/agent/state` as best-effort only and keep `/messages` as the durable baseline |
| Resume failure gets silently ignored and clients drift | Medium | High | Make `resync_required` explicit and keep recovery server-owned and simple |
| Older docs remain contradictory after the code change | High | Medium | Update protocol/spec/handoff docs and fixtures in the same phase as the semantics flip |
| Multi-instance service deployment still would not provide durable runtime bootstrap | High | Medium | Keep this plan scoped to the current single-instance prototype architecture and document that limit clearly |

## Rollout Strategy

1. Add explicit backend runtime snapshot support with monotonic resume tokens.
2. Move the reference web client onto `/agent/state` for thread-open bootstrap.
3. Add bounded resume plus explicit `resync_required` semantics to agent-stream attach.
4. Flip no-cursor agent-stream attach to live-only.
5. Update fixtures, protocol docs, and iOS handoffs.
6. Run manual validation for completed-thread reopen, active-turn open, reconnect replay, resync, and failure/cancel cleanup.

## Definition Of Done

- [ ] `/agent/state` exists, is documented, and is authorized like other thread-owned routes.
- [ ] reference web uses `/messages` plus `/agent/state` as the thread-open baseline.
- [ ] `stream_cursor` is a real opaque resume token, not merely a nullable last SSE id.
- [ ] snapshot cursor invariants are documented and tested.
- [ ] docs state explicitly that agent-stream SSE `id:` is the latest resume cursor after each incorporated event.
- [ ] no-cursor `agent/stream` attach is live-only in the shipped backend.
- [ ] bounded cursor-based replay still works for reconnect when the cursor is present in the resume window.
- [ ] stale or unknown cursor produces explicit `resync_required`.
- [ ] clients recover from `resync_required` by refetching `/messages` plus `/agent/state`.
- [ ] completed-thread passive reopen is visually stable.
- [ ] active-turn open still renders the current in-flight state correctly.
- [ ] handoff and plan docs define field-driven UI projection for `starting` / `thinking`, `pending_tool`, and `draft_assistant`.
- [ ] handoff and plan docs define fallback behavior when `/agent/state` fails while `/messages` succeeds.
- [ ] handoff and plan docs define non-destructive `agent.resync_required` handling while the user is reading older history.
- [ ] runtime snapshot only resets to idle after final durable state is available.
- [ ] touched specs, protocol docs, fixtures, and iOS handoffs are updated together.
- [ ] validation notes are captured in [validation-checklist.md](./validation-checklist.md).
