# iOS Agent Stream State And Resume Handoff

**Status:** Draft proposed backend contract, not yet shipped  
**Audience:** Backend, web platform, iOS, product  
**Last Updated:** 2026-03-26

## Purpose

This document is the draft backend handoff for the next iteration of `GET /api/threads/:thread_id/agent/stream`.

It is intentionally future-facing:

- it describes the contract we plan to implement
- it does **not** claim that this contract is already live in the current backend
- after implementation, this doc should be re-verified and updated to match the shipped behavior exactly

This draft incorporates:

- the iOS handoff in [`IOS_AGENT_STREAM_ATTACH_SEMANTICS_HANDOFF.md`](./IOS_AGENT_STREAM_ATTACH_SEMANTICS_HANDOFF.md)
- the backend design review in [`../design/mobile-agent-stream-attach-semantics.md`](../design/mobile-agent-stream-attach-semantics.md)
- the implementation plan in [`../plan/mobile-agent-stream-attach-semantics/implementation-spec.md`](../plan/mobile-agent-stream-attach-semantics/implementation-spec.md)

## Summary

The proposed model is:

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

## Proposed Routes

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

- the service may also continue to honor `Last-Event-ID` or `last_event_id`
- if those compatibility forms remain, mobile should treat `after=<cursor>` as the preferred contract once implementation is complete

Semantics:

- no cursor: live-only attach
- cursor present and resumable: bounded catch-up after that cursor, then live
- cursor present but not resumable: explicit `resync_required`

## Proposed `/agent/state` Contract

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
- ideally available on idle snapshots too

Mobile should not inspect or derive ordering from the cursor beyond sending it back to the server for resume.

## Proposed `/agent/stream` Semantics

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

Planned contract:

- `resync_required`

Potential transport shapes still to be finalized during implementation:

- HTTP `409` or `410`
- an initial SSE event such as `agent.resync_required`

The exact transport carrier is still implementation-pending.

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

## Open Implementation Details

These points are still draft and must be re-verified after code lands:

1. Whether the preferred resume transport is `after=<cursor>` only, or also `Last-Event-ID` / `last_event_id`.
2. Whether `resync_required` is delivered via HTTP status or an initial SSE event.
3. The exact bounded resume policy:
   - current turn only
   - short TTL window
   - or both
4. The exact `phase` enum values.

These are implementation details.

They should not change the core mobile model:

- fetch history
- fetch state
- attach stream after state cursor
- if resume fails, resync explicitly

## Relationship To Existing Docs

This draft is intended to become the future-facing companion or replacement for stream-specific sections in:

- [IOS_MOBILE_BACKEND_HANDOFF.md](./IOS_MOBILE_BACKEND_HANDOFF.md)
- [IOS_FEATURE_COMPLETE_PROTOTYPE_HANDOFF.md](./IOS_FEATURE_COMPLETE_PROTOTYPE_HANDOFF.md)
- [IOS_THREAD_MESSAGE_UX_BACKEND_RESPONSE.md](./IOS_THREAD_MESSAGE_UX_BACKEND_RESPONSE.md)

Until implementation lands and this doc is re-verified, those current docs still describe the shipped backend.
