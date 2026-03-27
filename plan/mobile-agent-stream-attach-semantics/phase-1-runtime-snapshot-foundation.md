# Phase 1: Runtime Snapshot Foundation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Add an explicit backend-owned current-turn snapshot so clients can bootstrap in-flight state without consuming old buffered SSE frames.

By the end of this phase:

- the service tracks agent runtime state per thread
- `GET /api/threads/:thread_id/agent/state` returns an authorized best-effort snapshot
- the snapshot includes enough information to seed UI state and attach to the live stream with a resume token
- the snapshot satisfies one explicit invariant: a snapshot with cursor `C` includes all runtime effects up to `C`

## Current Problem

Today the only current-runtime signal exposed to clients is the replay buffer behind `GET /api/threads/:thread_id/agent/stream`.

That is insufficient because:

- replay buffers are historical event sequences, not a direct runtime snapshot
- they are process-local and cleared only at the next turn start
- they cannot represent "turn is active, but no event has been emitted yet" cleanly
- they force clients to reconstruct state indirectly from old frames

The follow-up review sharpens the requirement:

- `stream_cursor` cannot just mean "latest emitted SSE id when one exists"
- it must be a real opaque monotonic resume token that exists early enough to close the `GET /state` -> `GET /stream` race

## Scope

### In Scope

- service-side runtime snapshot model
- agent lifecycle tracking updates in `AgentService`
- authorized `GET /api/threads/:thread_id/agent/state`
- unit or route-level tests for idle and active responses
- spec updates for the new route and runtime model

### Out Of Scope

- flipping no-cursor agent-stream attach semantics
- web adoption of the new route
- final iOS handoff/fixture updates

## Contract Direction

Target response shape:

```json
{
  "active": true,
  "turn_id": "01TURN...",
  "phase": "tool_running",
  "can_cancel": true,
  "stream_cursor": "01CUR...",
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

Idle shape:

```json
{
  "active": false,
  "turn_id": null,
  "phase": "idle",
  "can_cancel": false,
  "stream_cursor": "01CUR...",
  "pending_tool": null,
  "draft_assistant": null,
  "updated_at": "2026-03-26T20:15:04.000Z"
}
```

Cursor rule:

- `stream_cursor` is an opaque monotonic resume token
- it exists before the first visible event of an active turn
- it should also be returned on idle snapshots so clients can close `idle -> new turn` races cleanly
- the token is server-owned and clients must not attempt to inspect or derive ordering beyond exact equality/resume use

## Implementation Tasks

### Task 1: Define the runtime snapshot model and cursor invariant

Add a small in-memory model keyed by `thread_id` with fields for:

- `active`
- `turn_id`
- `phase`
- `started_at`
- `updated_at`
- `stream_cursor`
- `pending_tool`
- `draft_assistant_text`

Candidate location:

- new helper under `service/src/runtime/`
- or an `AgentService`-owned helper if that proves simpler

Candidate backing for the cursor:

- per-thread monotonic sequence number
- `turn_id + seq`
- a synthetic `turn_started` position that exists before the first user-visible SSE event

The concrete encoding matters less than the invariant:

- a snapshot with cursor `C` includes all runtime effects up to `C`

### Task 2: Update `AgentService` lifecycle tracking and cursor advancement

Update runtime state on:

- `startUserMessage(...)`
- `agent.tool_call`
- `agent.tool_result`
- `agent.message_start`
- `agent.message_delta`
- `agent.message_done`
- `final` success
- `final` failure
- `final` cancel

The snapshot must always end in idle after a completed turn, but only after:

1. final durable state is available
2. the resume token has advanced past that completion boundary

Do not clear to idle before the client has a stable way to observe the final coherent state.

### Task 3: Expose `GET /api/threads/:thread_id/agent/state`

Route requirements:

- same ownership rules as `/messages` and `/agent/stream`
- returns the current snapshot or idle state
- does not attach any listener or open any long-lived stream
- uses snake_case at the HTTP boundary
- returns `stream_cursor` on active snapshots and, ideally, on idle snapshots too

### Task 4: Add tests

Add targeted coverage for:

- idle thread response
- active turn response
- cursor exists before first visible event of an active turn
- cursor is returned on idle snapshots
- pending tool presence
- draft assistant text updates
- snapshot clear on success/failure/cancel
- snapshot-to-idle ordering after final durable state
- ownership enforcement before reading state

### Task 5: Update backend specs

Update:

- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/src.spec.md` if needed

The spec updates should describe the invariant plainly:

- state is the authoritative in-flight snapshot
- stream is transport after a snapshot cursor

## Validation Checklist

- [ ] idle thread returns `active: false`
- [ ] active turn returns `active: true` with `turn_id`
- [ ] `stream_cursor` exists before the first visible event of an active turn
- [ ] `stream_cursor` is returned on idle snapshots too
- [ ] `pending_tool` appears during tool execution and clears after tool result
- [ ] `draft_assistant.text` updates during streamed assistant text
- [ ] success resets the route to idle only after final durable state is available
- [ ] failure resets the route to idle only after final durable state is available
- [ ] cancel resets the route to idle only after final durable state is available
- [ ] unauthorized cross-user reads return `404`

## Exit Criteria

This phase is done when a client can learn "what is happening right now in this thread" and obtain a valid resume token from one explicit route rather than inferring either from buffered stream history.
