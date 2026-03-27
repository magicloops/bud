# iOS Agent Stream State And Resume Handoff

**Status:** Current backend contract  
**Audience:** Backend, web platform, iOS, product  
**Last Updated:** 2026-03-27

## Purpose

This document is the backend handoff for the current `GET /api/threads/:thread_id/agent/state` plus `GET /api/threads/:thread_id/agent/stream` contract.

It reflects the shipped implementation derived from:

- the iOS handoff in [`IOS_AGENT_STREAM_ATTACH_SEMANTICS_HANDOFF.md`](./IOS_AGENT_STREAM_ATTACH_SEMANTICS_HANDOFF.md)
- the backend design review in [`../design/mobile-agent-stream-attach-semantics.md`](../design/mobile-agent-stream-attach-semantics.md)
- the implementation plan in [`../plan/mobile-agent-stream-attach-semantics/implementation-spec.md`](../plan/mobile-agent-stream-attach-semantics/implementation-spec.md)

## Summary

The current model is:

- `/messages` = durable transcript history
- `/agent/state` = authoritative current in-flight snapshot
- `/agent/stream` = live transport plus a small bounded resume window
- if resume is impossible, the server responds with explicit `resync_required`
- the client then refetches `/messages` plus `/agent/state` and reconnects

Short version:

- state is truth
- stream is transport
- messages are history
- replay is only reconnect convenience

## Why This Is Changing

The current backend can replay stale buffered events on a fresh attach without a resume cursor.

That creates product problems on passive thread open:

- a completed tool can briefly look like it is running again
- a completed assistant turn can briefly look live again
- `Stop` can flash even when no turn is active

The new contract removes that ambiguity by separating:

- durable transcript state
- current in-flight runtime state
- short reconnect catch-up

## Routes

### 1. Durable Transcript History

```http
GET /api/threads/:thread_id/messages?limit=<n>
GET /api/threads/:thread_id/messages?limit=<n>&before=<cursor>
GET /api/threads/:thread_id/messages?limit=<n>&after=<cursor>
```

Semantics:

- durable source of truth for transcript rows
- same pagination model already documented elsewhere
- remains the baseline on thread open and after resync

### 2. Current In-Flight Runtime Snapshot

```http
GET /api/threads/:thread_id/agent/state
```

Semantics:

- authoritative current in-flight snapshot for the thread
- best-effort runtime state, not durable history
- authorized like other thread-owned routes
- used to bootstrap thread-open state before SSE attach

### 3. Live Agent Stream

Preferred public shape:

```http
GET /api/threads/:thread_id/agent/stream?after=<cursor>
```

Compatibility note:

- the service also honors `Last-Event-ID` and `last_event_id` for compatibility and browser/EventSource auto-resume
- native/mobile clients should use only `after=<cursor>` as the client-managed resume form
- native/mobile clients should not mix `after=<cursor>` with client-managed `Last-Event-ID` or `last_event_id`
- when both an existing stream URL and automatic browser resume are present, the backend prefers `Last-Event-ID` over the original query cursor

Semantics:

- no cursor: live-only attach
- cursor present and resumable: bounded catch-up after that cursor, then live
- cursor present but not resumable: explicit `resync_required`

## `/agent/state` Contract

### Response Shape

Active turn example:

```json
{
  "active": true,
  "turn_id": "01TURN8W1S8VWQK2S7G3A6M0P8X",
  "phase": "tool_running",
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

Idle example:

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

### Field Notes

- `active`: whether a turn is currently in flight
- `turn_id`: current turn identity when active
- `phase`: coarse runtime phase such as `starting`, `thinking`, `tool_running`, `streaming_message`, or `idle`
- `can_cancel`: whether the user should currently see cancel/stop affordance
- `stream_cursor`: opaque monotonic resume token for the thread runtime
- `pending_tool`: current in-flight tool call, if any
- `draft_assistant`: latest draft assistant text snapshot, if any
- `updated_at`: last snapshot update time

### Important Invariant

A snapshot with cursor `C` includes all runtime effects up to `C`.

That means `GET /api/threads/:thread_id/agent/stream?after=C` must do one of two things:

- deliver only effects after `C`
- explicitly require resync

### Cursor Notes

The cursor is:

- opaque
- server-owned
- monotonic
- available before the first visible event of an active turn
- returned on idle snapshots too

Mobile should not inspect or derive ordering from the cursor beyond sending it back to the server for resume.

### Cursor Advancement On Stream

For `GET /api/threads/:thread_id/agent/stream`, the SSE frame `id:` is the runtime resume cursor.

That means:

- `/agent/state.stream_cursor` and the agent-stream SSE `id:` share one cursor space
- after the client incorporates an SSE event with `id: C_next`, it should store `C_next` as the next resume cursor
- frames without `id:` such as `heartbeat` or `agent.resync_required` do not advance the cursor

## `/agent/stream` Semantics

### No Cursor

```http
GET /api/threads/:thread_id/agent/stream
```

Behavior:

- open the stream
- optional `heartbeat`
- no replay of old buffered `agent.*` or `final` events
- only genuinely new events after attach are delivered

This is the key passive-open behavior change.

### Cursor Present And Resumable

```http
GET /api/threads/:thread_id/agent/stream?after=01CUR...
```

Behavior:

- deliver only effects strictly after that cursor
- resume only within a bounded catch-up window
- continue live after the catch-up

The catch-up window is intended to cover:

- the race between `/agent/state` fetch and stream attach
- short reconnects

It is not intended to act like transcript history.

### Cursor Present But Not Resumable

If the supplied cursor is too old, unknown, or otherwise not resumable, the server should explicitly require resync.

Current contract:

- `resync_required`
- delivered as an initial SSE event: `agent.resync_required`
- payload shape:

```json
{
  "error": "resync_required",
  "provided_cursor": "01CUR..."
}
```

- after sending `agent.resync_required`, the service ends that SSE response and the client should refetch `/messages` plus `/agent/state` before reattaching

The important part for mobile is:

- resume failure will be explicit
- mobile should not infer it from missing deltas or custom gap-repair logic

## Recommended Mobile Thread-Open Flow

1. `GET /api/threads/:thread_id/messages?limit=<n>`
2. `GET /api/threads/:thread_id/agent/state`
3. render canonical transcript from `/messages`
4. overlay current pending-tool / draft-assistant / stop-button state from `/agent/state`
5. attach `GET /api/threads/:thread_id/agent/stream?after=<state.stream_cursor>`
6. if the server responds with `resync_required`, repeat steps 1-5

Why this is the preferred model:

- passive open of a completed thread is stable
- active-turn open still gets explicit current state
- short reconnects can resume smoothly
- failure recovery stays simple

## Recommended Mobile Reconnect Flow

When a stream disconnect happens:

1. reconnect with the last known cursor
2. if resume succeeds, continue live
3. if resume fails with `resync_required`, fetch `/messages`
4. fetch `/agent/state`
5. reconnect from the new cursor

The client should optimize for convergence to the latest coherent state, not perfect delivery of every intermediate token or tool transition.

## Runtime Overlay Projection Rules

Projection is field-driven, not phase-driven.

- `idle`: render the canonical transcript only. No pending-tool row, no draft-assistant row, no stop affordance.
- `starting`: show active-turn / stop-button state from `active` plus `can_cancel`, but do not invent transcript rows from `phase` alone.
- `thinking`: same rule as `starting`. The client may show a generic "working" indicator outside the transcript, but should not synthesize tool or assistant rows unless the corresponding fields are present.
- `pending_tool`: if `pending_tool` is present, render exactly one pending tool overlay row keyed by `call_id`. Replace or remove it when later snapshot or stream state says it is gone.
- `draft_assistant`: if `draft_assistant` is present, render exactly one draft assistant overlay row keyed by `turn_id`. Replace it with the canonical `agent.message` or `/messages` row when persistence completes.
- if both `pending_tool` and `draft_assistant` are present, render the fields that are present. Do not synthesize additional rows from `phase` alone.

## Fallback If `/agent/state` Temporarily Fails

If `/messages` succeeds but `/agent/state` fails:

- render the canonical transcript from `/messages`
- suppress stop-button and synthetic runtime overlay rows until `/agent/state` succeeds
- retry `/agent/state`; do not infer current runtime state from old transcript rows
- if the product chooses to open the stream before `/agent/state` recovers, attach live-only with no cursor and accept that resumable continuity is temporarily unavailable

This keeps the client correct even when runtime bootstrap is temporarily unavailable.

## Product Rule For `agent.resync_required` While Reading Older History

Treat `agent.resync_required` as a data-repair signal, not a forced navigation event.

Recommended behavior:

- refetch `/messages` plus `/agent/state` in the background
- update the local model to the latest canonical state
- preserve the user's current older-history reading position when possible
- do not auto-jump to the latest message unless the user was already anchored there or explicitly requests it
- show a non-blocking "conversation refreshed" or "jump to latest" affordance if the product wants visible confirmation

## Event Semantics Under The Proposed Model

The live event family is still expected to look like:

- `agent.message_start`
- `agent.message_delta`
- `agent.message_done`
- `agent.tool_call`
- `agent.tool_result`
- `agent.message`
- `final`
- `heartbeat`

Success-path reconciliation remains:

- use `turn_id` for draft grouping
- use `call_id` for tool lifecycle reconciliation
- use canonical `message.message_id` when a persisted row exists

Important client rule:

- do not treat streamed deltas alone as durable transcript state
- use canonical `/messages` rows for durable correctness

## Runtime Finalization Rule

The server should not clear runtime state to idle too early.

Safe ordering:

1. persist final assistant message or final durable result
2. advance the runtime cursor so the final coherent state is observable
3. clear `/agent/state` back to idle

This avoids the reconnect edge case where the client sees:

- no active turn
- but also no final durable result yet

## Storage / Robustness Scope

For the initial implementation, the expected scope is:

- same-instance continuity
- best-effort bounded resume
- correctness recovered through `/messages` plus `/agent/state`

If production later requires robust cross-instance reconnect continuity, backend should move snapshot state and the bounded resume window into shared ephemeral storage such as Redis with TTL.

That is a backend infrastructure concern, not a client gap-repair concern.

## What Mobile Should Not Assume

Mobile should not assume:

- full replay of prior turn history on fresh attach
- durable event-log semantics from SSE
- exact delivery of every token across reconnects
- client-led gap repair as the primary recovery model

## Current Implementation Details

The current service implementation uses:

1. one opaque cursor space shared by `/agent/state.stream_cursor` and agent-stream SSE frame `id:`
2. `after=<cursor>` as the preferred explicit client-managed resume form
3. compatibility resume via `Last-Event-ID` and `last_event_id`
4. explicit `agent.resync_required` SSE delivery on resume misses
5. a bounded same-instance in-memory replay window for reconnect convenience
   - currently capped to a small process-local ring buffer (256 entries, 60-second TTL)
6. current snapshot phases:
   - `idle`
   - `starting`
   - `thinking`
   - `tool_running`
   - `streaming_message`

That replay window is intentionally not durable transcript history.

The durable recovery path remains:

- fetch history
- fetch state
- attach stream after state cursor
- if resume fails, resync explicitly

## Relationship To Existing Docs

This document replaces the older mobile stream docs that described the pre-change replay model and were removed from the reference package once the bounded-resume contract shipped.
