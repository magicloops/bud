# Design: Agent Stream Attach Semantics And Runtime Bootstrap

Status: Draft

Audience: Backend, web platform, iOS

Last updated: 2026-03-27

## 1. Goal

Remove stale attach-time replay from passive thread open while preserving a clean way for clients to render a genuinely active turn that started before they attached.

This design is intentionally about the agent stream contract, not a broader transcript or terminal redesign.

## 2. Review Summary

The current backend behavior is clear from the implementation:

- [`service/src/routes/threads.ts`](../service/src/routes/threads.ts) passes `Last-Event-ID` or `last_event_id` directly into the shared SSE event bus for `GET /api/threads/:thread_id/agent/stream`
- [`service/src/runtime/event-bus.ts`](../service/src/runtime/event-bus.ts) replays the entire in-memory buffer when no cursor is provided
- [`service/src/agent/agent-service.ts`](../service/src/agent/agent-service.ts) clears that buffer at the start of the next turn, not when the current turn finishes

Direct consequence:

- reopening a completed thread can replay stale previous-turn `agent.tool_call`, `agent.message_start`, `agent.message_delta`, `agent.message_done`, `agent.message`, and `final` events if the process still has them buffered
- restarting the service clears that process-local buffer, which matches the mobile report that the flicker disappears after a dev-server restart

The earlier mobile handoff docs, which have since been removed from `reference/`, were not aligned:

- one could be read as "events are replayed on attach"
- one described cursor-aware replay and live-only fallback when a resume cursor is missing
- one explicitly matched the old code path where no-cursor attach replayed the whole current in-memory buffer

This means the mobile team is reacting to a real backend contract problem, not only to local UI implementation details.

## 3. Problem Statement

The current design uses one mechanism, process-local event replay, for two different jobs:

1. reconnect gap fill
2. bootstrap of a thread view that attaches after a turn has already started

That coupling creates four problems:

- passive open of a completed thread can look active again
- fresh attach semantics are ambiguous, so documentation drift keeps reappearing
- clients have no explicit current-runtime surface, so they infer state by re-consuming historical stream frames
- the system does not clearly distinguish durable transcript state from ephemeral in-flight state

## 4. Design Principles

- `GET /api/threads/:thread_id/messages` remains the durable transcript source of truth
- `GET /api/threads/:thread_id/agent/state` is the authoritative in-flight snapshot surface
- `GET /api/threads/:thread_id/agent/stream` should represent live continuation, not attach-time history
- replay should be explicit, bounded, and cursor-driven
- the system should optimize for convergence after reconnect, not perfect delivery of every intermediate delta
- passive reopen of a completed thread must be visually stable
- active-turn bootstrap should describe current state directly, not re-stage an old sequence of frames
- a snapshot with cursor `C` must include all runtime effects up to `C`
- `/agent/stream` after `C` must either deliver only effects after `C` or explicitly require resync
- browser-facing ownership rules still apply to any new runtime surface

Short version:

- state is truth
- stream is transport
- messages are history
- replay is only reconnect convenience

## 5. Recommendation

### 5.1 End-State Stream Semantics

Agent stream semantics should become:

#### No cursor supplied

- live-only attach
- do not replay buffered `agent.*` or `final`
- sending an initial `heartbeat` is still fine

#### Cursor supplied and found

- replay only effects strictly after that cursor
- then continue live

#### Cursor supplied but missing or stale

- return explicit `resync_required`
- the client refetches `/messages` plus `/agent/state`, then reattaches

This makes the stream contract simple:

- no-cursor attach means "from now forward"
- cursor attach means "bounded catch-up if possible"

The stream is not history. It is live transport plus a short server-owned catch-up window that covers:

- the race between `GET /agent/state` and `GET /agent/stream`
- short reconnects on mobile

The stream should not become a foundation for rebuilding transcript state from deltas.

Recommended carrier shape:

- preferred public contract: `GET /api/threads/:thread_id/agent/stream?after=<cursor>`
- compatibility transport such as `Last-Event-ID` or `last_event_id` can remain if useful
- native/mobile clients should use `after=<cursor>` as the only client-managed resume input rather than mixing multiple resume carriers
- for agent stream frames, SSE `id:` is the same opaque runtime cursor space exposed as `/agent/state.stream_cursor`

The important point is not the exact field name. It is that the cursor is explicit, opaque, and server-owned.

### 5.2 Add Explicit Active-Turn Bootstrap

To support opening a thread while a turn is already in progress, add a lightweight owned runtime snapshot route instead of overloading SSE replay.

Proposed route:

- `GET /api/threads/:thread_id/agent/state`

Proposed response:

```json
{
  "active": true,
  "turn_id": "01TURN8W1S8VWQK2S7G3A6M0P8X",
  "phase": "thinking",
  "can_cancel": true,
  "stream_cursor": "01CUR8W1S9J6K4Q7F2Q9P1ZB3G",
  "pending_tool": {
    "call_id": "call_123",
    "name": "terminal.run",
    "args": { "input": "git status\n" }
  },
  "draft_assistant": {
    "text": "Working through the repo...",
    "updated_at": "2026-03-26T20:15:04.000Z"
  },
  "updated_at": "2026-03-26T20:15:04.000Z"
}
```

When idle:

```json
{
  "active": false,
  "turn_id": null,
  "phase": "idle",
  "can_cancel": false,
  "stream_cursor": "01CUR8W1S9J6K4Q7F2Q9P1ZB3G",
  "pending_tool": null,
  "draft_assistant": null,
  "updated_at": "2026-03-26T20:15:04.000Z"
}
```

Route semantics:

- best-effort, process-local runtime view
- not a durable transcript source
- authorized the same way as `messages` and `agent/stream`
- `stream_cursor` is an opaque monotonic resume token, not just "latest SSE id if one exists"
- `stream_cursor` exists before the first visible event of an active turn
- `stream_cursor` is also returned on idle snapshots to close `idle -> new turn` races
- a snapshot with cursor `C` includes all runtime effects up to `C`
- a later streamed SSE event with `id: C_next` advances that same cursor space
- after `final`, the route returns idle state only after final durable state is available and the cursor has advanced past that completion boundary

### 5.3 Recommended Thread-Open Sequence

For web and iOS:

1. In parallel, fetch:
   - `GET /api/threads/:thread_id/messages?limit=<n>`
   - `GET /api/threads/:thread_id/agent/state`
2. Render `/messages` as the baseline transcript.
3. If `agent/state` is active, overlay the ephemeral draft/pending-tool/runtime UI from that snapshot.
4. Attach `GET /api/threads/:thread_id/agent/stream?after=<agent_state.stream_cursor>`.
5. If the server responds with explicit `resync_required`:
   - refetch `/messages`
   - refetch `/agent/state`
   - reattach from the new cursor
6. Reconcile live events by `turn_id`, `call_id`, and canonical `message.message_id`.

Why this works:

- passive open of a completed thread is stable because no-cursor attach is live-only
- active-turn open still has explicit current state without replaying completed turns
- the snapshot cursor closes the gap between snapshot fetch and stream attach
- the bounded catch-up window makes short reconnects feel good without turning SSE into history
- if resume is impossible, the recovery path is simple and server-owned rather than inferred by the client

If `/messages` succeeds but `/agent/state` fails:

- render the canonical transcript only
- suppress stop-button and synthetic runtime overlay rows until `/agent/state` succeeds
- retry `/agent/state`
- if the client chooses to open the stream before `/agent/state` recovers, attach live-only with no cursor and accept temporarily degraded continuity

### Client Projection Rules

Projection should be field-driven rather than phase-driven.

- `starting` and `thinking` mean the turn is active, but they do not create transcript rows on their own
- `pending_tool` creates at most one synthetic pending-tool row keyed by `call_id`
- `draft_assistant` creates at most one synthetic assistant draft row keyed by `turn_id`
- `can_cancel` rather than `phase` should drive the stop affordance
- if `agent.resync_required` arrives while the user is reading older history, the client should repair data in the background without forcibly jumping the user to the latest view

### 5.4 Runtime State Model Inside The Service

Add a small in-memory runtime store keyed by `thread_id`, updated by [`service/src/agent/agent-service.ts`](../service/src/agent/agent-service.ts).

Suggested fields:

- `active`
- `turn_id`
- `phase`
- `started_at`
- `updated_at`
- `stream_cursor`
- `pending_tool`
- `draft_assistant_text`

Suggested phase values:

- `starting`
- `thinking`
- `tool_running`
- `streaming_message`
- `idle`

Suggested update points:

- `startUserMessage(...)` creates the runtime entry and advances the cursor before the first provider event
- `agent.tool_call` sets `tool_running`
- `agent.tool_result` clears `pending_tool` and returns to `thinking`
- `agent.message_start` / `agent.message_delta` / `agent.message_done` set `streaming_message` and update the current draft text
- after final durable state is committed, advance the cursor past that completion boundary and then clear the active snapshot back to idle

Suggested cursor backing:

- per-thread monotonic sequence number
- `turn_id + seq`
- a synthetic `turn_started` position that exists before the first visible event

This runtime store is intentionally separate from the resume window:

- the resume window exists for bounded cursor recovery
- the runtime snapshot exists for explicit current-state bootstrap

Suggested finalization ordering:

1. persist final assistant message or final terminal/tool outcome
2. advance the runtime cursor and make the final coherent state observable
3. reset runtime state to idle

That ordering avoids the reconnect edge case where a client sees neither an active turn nor the final durable result.

### 5.5 Resume Window And Storage

For the first pass:

- a same-instance, process-local ring buffer with TTL is acceptable
- the buffer should be intentionally small, such as current-turn effects or a short time window
- correctness still comes from `/messages` plus `/agent/state`

If production robustness later requires reconnects to survive non-sticky or cross-instance routing, move the snapshot plus resume window into shared ephemeral storage such as Redis with TTL.

That is a cleaner next step than pushing more gap-detection and repair logic into clients.

### 5.6 Documentation And Fixtures

The contract should be updated in one pass across:

- [`docs/proto.md`](../docs/proto.md)
- [`service/src/routes/routes.spec.md`](../service/src/routes/routes.spec.md)
- [`service/src/runtime/runtime.spec.md`](../service/src/runtime/runtime.spec.md)
- [`reference/IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md`](../reference/IOS_AGENT_STREAM_STATE_AND_RESUME_HANDOFF.md)
- [`reference/IOS_AGENT_STREAM_STATE_AND_RESUME_FIXTURES.md`](../reference/IOS_AGENT_STREAM_STATE_AND_RESUME_FIXTURES.md)

New fixtures should cover:

- passive completed-thread open: messages baseline plus no-cursor live-only attach
- active-turn open using `agent/state` plus cursor attach
- stale cursor producing explicit `resync_required`
- reconnect during an active turn

The final mobile handoff should explain the model in the same short language:

- messages are durable history
- state is the authoritative in-flight snapshot
- stream is transport after a cursor
- replay is only bounded reconnect convenience

## 6. Alternatives Considered

### 6.1 Keep Current Attach Replay And Just Document It

Rejected.

- it preserves the exact behavior that is causing mobile confusion
- every client still has to distinguish historical attach-time frames from genuinely new live activity
- completed-thread passive open remains unstable

### 6.2 Clear The Buffer Immediately After `final`

Better than today, but incomplete.

- it prevents stale completed-turn replay on reopen
- it does not create an explicit active-turn bootstrap surface
- it still uses historical frames as the only way to discover current runtime state on a fresh attach

### 6.3 Make The Client Repair Gaps From Stream Metadata

Rejected.

- gap detection is easier than gap repair
- the hard cases all land on each client: partial assistant text, tool-in-flight, turn finished while disconnected, failure/cancel boundaries, duplicate suppression, and attach races
- the recovery logic belongs on the server once, not in every client

### 6.4 Add `attach_mode=current_turn_bootstrap` To The Stream

Acceptable as a smaller fallback, but not preferred.

- it is better than implicit replay because bootstrap becomes explicit
- it still couples current-state bootstrap to historical event reenactment
- it leaves one route doing two distinct jobs
- it is weaker than a snapshot route for the "turn is active but no event has been emitted yet" case

### 6.5 Keep Full Replay As A Core Feature

Rejected.

- it makes the stream pretend to be history
- it encourages clients to rebuild coherent state indirectly from deltas
- it quickly grows system complexity around retention, expiration, ordering, turn boundaries, duplicates, and cross-instance behavior
- most of that complexity is unnecessary if the actual product goal is reconnect convergence rather than perfect transport replay

## 7. Rollout

Recommended rollout order:

1. Add `agent/state`, the runtime snapshot store, and opaque monotonic cursors.
2. Update the web client to consume `agent/state` on thread open so we do not regress mid-turn opens when attach semantics change.
3. Add bounded resume plus explicit `resync_required`.
4. Change `agent/stream` no-cursor semantics to live-only.
5. Update iOS and the backend handoff docs to the new open sequence.
6. Remove any remaining documentation that implies "buffered events replay on fresh attach."

If we want a lower-risk transition, we can temporarily gate the new fresh-attach behavior behind an explicit opt-in query parameter while web and iOS adopt `agent/state`. That rollout detail should not change the target contract.

## 8. Expected File Areas

Service:

- [`service/src/routes/threads.ts`](../service/src/routes/threads.ts)
- [`service/src/agent/agent-service.ts`](../service/src/agent/agent-service.ts)
- [`service/src/runtime/event-bus.ts`](../service/src/runtime/event-bus.ts)
- [`service/src/runtime/event-bus.test.ts`](../service/src/runtime/event-bus.test.ts)

Docs and specs:

- [`docs/proto.md`](../docs/proto.md)
- [`service/src/routes/routes.spec.md`](../service/src/routes/routes.spec.md)
- [`service/src/runtime/runtime.spec.md`](../service/src/runtime/runtime.spec.md)
- mobile/reference handoff docs and fixtures under [`reference/`](../reference/)

Reference web client:

- [`web/src/routes/$budId/$threadId.tsx`](../web/src/routes/%24budId/%24threadId.tsx)

## 9. Decision Summary

The stale replay seen by iOS is a backend contract issue, not only a UI issue.

The clean fix is to separate two concerns that are currently mixed together:

- `agent/state` becomes the explicit bootstrap surface for current in-flight runtime state and resume position
- `agent/stream` becomes live-only by default and only provides bounded catch-up when the client explicitly resumes from a cursor

That contract is simpler to explain, safer for passive transcript open, and more robust for both iOS and web without turning SSE into an event store.
