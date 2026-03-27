# Phase 2: Reference Web Adoption

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Move the reference web thread view onto the new `/agent/state` bootstrap model before changing fresh-attach stream semantics.

By the end of this phase:

- thread open loads canonical transcript history plus runtime snapshot
- the web UI can render an already-active turn without relying on stale attach replay
- the stream attaches using the snapshot `stream_cursor`
- reconnect and attach recovery treat `resync_required` as a simple server-owned path, not a client-led gap repair problem

## Current Problem

The current web route can tolerate replay and reconnect, but it still implicitly benefits from the current behavior where a fresh no-cursor attach can replay buffered activity.

If we flip stream semantics first:

- mid-turn thread open could lose the existing draft/tool/stop-button bootstrap path
- the web client would become the regression vector even if the new contract is better for mobile

## Scope

### In Scope

- thread-open fetch sequence changes in the reference web route
- UI hydration from `/agent/state`
- attach with `stream_cursor` when present
- thread-open and reconnect behavior validation
- web/spec updates for the new consumption model

### Out Of Scope

- iOS client implementation changes
- final backend handoff doc updates
- changing terminal bootstrap behavior

## Contract Direction

Recommended thread-open sequence:

1. fetch `GET /api/threads/:thread_id/messages?limit=<n>`
2. fetch `GET /api/threads/:thread_id/agent/state`
3. render `/messages` as the durable baseline
4. overlay draft assistant, pending tool, stop-button state, and any other ephemeral runtime UI from `/agent/state`
5. attach `GET /api/threads/:thread_id/agent/stream?after=<agent_state.stream_cursor>`
6. store later agent-stream SSE `id:` values as the next resume cursor
7. if the server responds with explicit `resync_required`, refetch `/messages` plus `/agent/state` and attach again

Resume discipline:

- the web/mobile client should use `after=<cursor>` as its single client-managed resume input
- do not add separate client-managed `Last-Event-ID` or `last_event_id` handling on top
- browser/EventSource transport may still emit `Last-Event-ID` automatically during reconnects; that is compatibility behavior, not the primary client contract

## Implementation Tasks

### Task 1: Fetch `/agent/state` on thread open

Update the route so thread bootstrap explicitly pulls:

- canonical messages
- current runtime snapshot

Prefer parallel fetch where it keeps the route simpler.

### Task 2: Hydrate ephemeral UI from the snapshot

Use snapshot state to seed:

- pending tool row
- draft assistant row
- stop-button visibility
- any local "streaming" status tied to an active turn

The snapshot should not replace canonical transcript rows; it should only overlay ephemeral state.

Projection rules for the client:

- `starting` and `thinking` do not create transcript rows on their own
- `pending_tool` creates at most one synthetic pending-tool row keyed by `call_id`
- `draft_assistant` creates at most one synthetic assistant draft row keyed by `turn_id`
- `can_cancel` rather than `phase` should drive the stop affordance

### Task 3: Attach the stream with the snapshot cursor

Use the snapshot cursor on thread open and reconnect.

The client should not treat the stream as gap-discovery infrastructure.

If the server cannot resume from the supplied cursor:

- follow the explicit `resync_required` path
- refetch `/messages`
- refetch `/agent/state`
- reattach from the new snapshot cursor

If `/messages` succeeds but `/agent/state` fails:

- render the canonical transcript only
- suppress stop-button and synthetic runtime rows until `/agent/state` succeeds
- retry `/agent/state`
- if the product chooses to attach before `/agent/state` recovers, attach live-only with no cursor

### Task 4: Remove dependence on stale fresh-attach replay and client gap repair

Audit the web route for any remaining assumptions that a fresh attach will replay recent buffered events from the beginning of the turn.

If needed:

- make the bootstrap ordering explicit in comments or small helper functions
- keep reconnect recovery intact
- avoid adding `prev_id` or other client-side gap-repair logic as the primary recovery model

Also define the detached-reader product rule:

- when `agent.resync_required` arrives while the user is reading older history, repair data in the background
- do not auto-jump the user to the latest message unless they were already anchored there or explicitly request it

### Task 5: Update web specs

Update:

- `web/src/routes/$budId/budId.spec.md`
- `web/src/components/workbench/workbench.spec.md` if the bootstrap story is described there

The web specs should describe the client model simply:

- history from `/messages`
- in-flight truth from `/agent/state`
- transport from `/agent/stream`

## Validation Checklist

- [ ] completed-thread open renders from `/messages` without needing attach replay
- [ ] active-turn open shows pending tool state from `/agent/state`
- [ ] active-turn open shows draft assistant state from `/agent/state`
- [ ] stop-button state comes from actual runtime activity, not stale replay
- [ ] `starting` / `thinking` do not create synthetic transcript rows by themselves
- [ ] `pending_tool` and `draft_assistant` project to one overlay row each when present
- [ ] stream attaches with `?after=<snapshot_cursor>`
- [ ] later agent-stream SSE `id:` values are treated as the next resume cursor
- [ ] the client does not manually mix in `Last-Event-ID` or `last_event_id`
- [ ] reconnect recovery handles explicit `resync_required`
- [ ] `/messages` success plus `/agent/state` failure still renders a correct transcript-only view
- [ ] `agent.resync_required` while detached from latest does not forcibly jump the user to the bottom
- [ ] the client does not need client-side gap repair for normal recovery
- [ ] web specs describe the new bootstrap sequence accurately

## Exit Criteria

This phase is done when the reference web client demonstrates the target consumption pattern: canonical history for durable transcript, `/agent/state` for current ephemeral runtime plus resume cursor, and SSE for live continuation or explicit resync.
