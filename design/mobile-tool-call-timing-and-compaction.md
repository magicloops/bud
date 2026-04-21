# Design: Mobile Tool Call Timing And Compaction

Status: Draft

Audience: Backend, iOS, web

Last updated: 2026-04-21

## 1. Goal

Support grouped or compacted tool rows in the mobile app without introducing a new grouped-transcript backend contract.

This tranche is intentionally narrow:

- preserve the existing thread/message/agent-stream route family
- keep grouped summary rows as a client-side presentation concern
- add authoritative backend timing for completed tool calls
- optionally add server-clock timestamps to live tool SSE events so mobile no longer has to infer timing from local receipt time

This tranche does not redesign assistant streaming, turn summaries, or message grouping on the backend.

## 2. Review Summary

The current backend is already structurally compatible with grouped tool summary rows.

What already exists:

- `agent.tool_call` gives the client a stable pending-tool identity via `client_id` and `call_id`
- `agent.tool_result` later returns the persisted canonical tool message under `message`
- persisted tool rows already carry rich tool metadata such as `tool`, `call_id`, `summary`, `output`, `readiness`, `delta`, and `context_after`
- `/api/threads/:thread_id/messages` already returns that canonical tool metadata under `message.metadata`

What is missing:

- no authoritative start/end timing for one tool call
- no duration field on canonical tool metadata
- no server timestamps on `agent.tool_call` or `agent.tool_result`

Because of that gap, mobile can collapse sequential tool rows today, but it cannot accurately show how long a tool took except by using local receipt timestamps.

## 3. Current Implementation Review

### 3.1 Tool call lifecycle today

The current service flow is:

1. `AgentService.runAgentFlow(...)` detects a tool call from the model.
2. `AgentTranscriptWriter.emitToolCall(...)` emits `agent.tool_call` and updates `/agent/state.pending_tool`.
3. `TerminalToolExecutor.execute(...)` runs the terminal action and builds the tool payload/summary.
4. `AgentTranscriptWriter.recordToolResult(...)` persists a `message.role = "tool"` row and emits `agent.tool_result`.

Relevant current boundaries:

- `agent.tool_call` is emitted before tool execution begins
- the canonical tool row is persisted only after execution completes
- `message.created_at` therefore reflects persistence time, not tool-start time

### 3.2 Canonical tool row shape today

Today the persisted tool row is built from `execution.payload`.

Current fields already persisted in tool metadata include:

- `tool`
- `call_id`
- tool args such as `text`, `submit`, `key`, `lines`, `view`, `wait_for`
- `summary`
- `kind`
- `output`
- `output_bytes`
- `readiness`
- `truncated`
- `output_truncation_reason`
- `omitted_lines`
- `submitted`
- `delta`
- `error`
- `context_after`

Current implementation detail:

- `message.content` is `JSON.stringify(execution.payload)`
- `message.metadata` is also `execution.payload`

That means tool `content` and tool `metadata` are currently mirrors of each other.

### 3.3 Stream payloads today

Current live tool events are:

`agent.tool_call`

```json
{
  "turn_id": "01TURN...",
  "client_id": "019...",
  "call_id": "call_123",
  "name": "terminal.send",
  "args": {
    "text": "pwd",
    "submit": true
  }
}
```

`agent.tool_result`

```json
{
  "turn_id": "01TURN...",
  "client_id": "019...",
  "call_id": "call_123",
  "message_id": "uuid",
  "name": "terminal.send",
  "summary": "Attempted to send \"pwd\"",
  "output": null,
  "output_bytes": null,
  "readiness": {},
  "truncated": false,
  "output_truncation_reason": null,
  "omitted_lines": 0,
  "message": {
    "message_id": "uuid",
    "client_id": "019...",
    "role": "tool",
    "display_role": "Tool",
    "content": "{...}",
    "metadata": { "...": "..." },
    "created_at": "2026-04-21T18:00:05.000Z"
  }
}
```

Neither event carries a timestamp today.

### 3.4 Why grouped summary rows already work

Grouped rows do not require a new backend grouping primitive because the current contract already provides:

- adjacency in the transcript timeline
- stable per-message identity via `client_id`
- stable per-tool identity via `call_id`
- per-tool summary text
- a canonical persisted tool row for transcript recovery

So the mobile recommendation is correct:

- grouped summary rows are a presentation-layer concern
- no new grouped transcript route or grouped SSE event is required

## 4. Problem Statement

The mobile app wants to:

- collapse sequential tool calls into one visual summary row
- show how long each tool call took
- compute totals such as total tool time in a turn
- align live timing with backend time rather than local receipt time

The current backend cannot support those accurately because:

- `message.created_at` only tells the client when the row was persisted
- no canonical tool metadata records the start time
- no tool SSE event exposes backend time
- local receipt timestamps drift due to network latency, backgrounding, reconnects, and replay

## 5. Decision

### 5.1 Keep grouping client-side

Grouped summary rows remain a client concern.

No new backend grouping event, route, or transcript shape is required.

### 5.2 Add tool timing to canonical tool metadata

Add the following fields to persisted canonical tool metadata:

- `started_at`
- `finished_at`
- `duration_ms`

Recommended semantics:

- `started_at`: service timestamp captured immediately before `agent.tool_call` is emitted and before the tool is executed
- `finished_at`: service timestamp captured immediately after tool execution resolves, before the canonical tool row is emitted
- `duration_ms`: integer duration derived from `finished_at - started_at`

### 5.3 Add matching timing to live tool events

Additive stream changes:

- `agent.tool_call` gains `started_at`
- `agent.tool_result` gains `started_at`, `finished_at`, and `duration_ms`

This lets live UI timing align to server time and also lets a client recover if it only sees the result event.

### 5.4 Keep timing in `metadata`, not in tool `content`

Recommended persistence rule:

- add timing fields to canonical `message.metadata`
- keep `message.content` as the existing model-facing execution payload without timing

This is the most important implementation detail in the design.

Reasoning:

- the UI already prefers `message.metadata` when rendering tool payloads
- `/messages` already returns `metadata`, so no route change is needed
- `conversation-loader.ts` currently replays tool history from `message.content`, not `message.metadata`
- keeping timing out of `content` avoids growing model replay payloads with UI-only timing data

This means tool `content` and tool `metadata` will no longer be exact mirrors after this change. That is acceptable and is preferable to adding extra replay noise to future model turns.

## 6. Proposed Contract

### 6.1 Canonical persisted tool metadata

Recommended tool message shape after persistence:

```json
{
  "message_id": "uuid",
  "client_id": "019...",
  "role": "tool",
  "display_role": "Tool",
  "content": "{\"tool\":\"terminal.send\",\"call_id\":\"call_123\",\"text\":\"pwd\",\"submit\":true,\"summary\":\"Attempted to send \\\"pwd\\\"\",...}",
  "metadata": {
    "tool": "terminal.send",
    "call_id": "call_123",
    "text": "pwd",
    "submit": true,
    "summary": "Attempted to send \"pwd\"",
    "kind": "interaction_ack",
    "output": null,
    "output_bytes": null,
    "readiness": {},
    "truncated": false,
    "output_truncation_reason": null,
    "omitted_lines": 0,
    "submitted": true,
    "delta": null,
    "error": null,
    "context_after": {
      "mode": "shell",
      "source": "observed"
    },
    "started_at": "2026-04-21T18:00:03.120Z",
    "finished_at": "2026-04-21T18:00:05.487Z",
    "duration_ms": 2367
  },
  "created_at": "2026-04-21T18:00:05.489Z"
}
```

Important note:

- `created_at` remains the message-row persistence time
- `finished_at` is the tool execution finish boundary
- those timestamps will usually be close, but they are not the same field and should not be treated as the same thing

### 6.2 `agent.tool_call`

Proposed additive payload:

```json
{
  "turn_id": "01TURN...",
  "client_id": "019...",
  "call_id": "call_123",
  "name": "terminal.send",
  "args": {
    "text": "pwd",
    "submit": true
  },
  "started_at": "2026-04-21T18:00:03.120Z"
}
```

### 6.3 `agent.tool_result`

Proposed additive payload:

```json
{
  "turn_id": "01TURN...",
  "client_id": "019...",
  "call_id": "call_123",
  "message_id": "uuid",
  "name": "terminal.send",
  "summary": "Attempted to send \"pwd\"",
  "output": null,
  "output_bytes": null,
  "readiness": {},
  "truncated": false,
  "output_truncation_reason": null,
  "omitted_lines": 0,
  "started_at": "2026-04-21T18:00:03.120Z",
  "finished_at": "2026-04-21T18:00:05.487Z",
  "duration_ms": 2367,
  "message": {
    "message_id": "uuid",
    "client_id": "019...",
    "role": "tool",
    "display_role": "Tool",
    "content": "{...}",
    "metadata": {
      "...": "...",
      "started_at": "2026-04-21T18:00:03.120Z",
      "finished_at": "2026-04-21T18:00:05.487Z",
      "duration_ms": 2367
    },
    "created_at": "2026-04-21T18:00:05.489Z"
  }
}
```

No other stream payload change is required for grouped rows.

## 7. Why Choose Timestamps Instead Of Duration Alone

The mobile request suggested two options:

- `duration_ms`
- `started_at` and `finished_at`

This design recommends carrying timestamps and also including `duration_ms`.

Reasons:

- grouped rows may want a total summed duration and also a wall-clock interval
- server-clock alignment for live UI requires timestamps, not just a duration
- future debugging is easier when both boundaries exist
- `duration_ms` is still convenient for direct display and aggregation

If implementation scope needs to stay even narrower, the minimum acceptable version is:

- canonical metadata: `started_at`, `finished_at`
- `agent.tool_call`: `started_at`
- `agent.tool_result`: `started_at`, `finished_at`

and let clients derive `duration_ms`.

## 8. Total-Time Calculations

### 8.1 What this tranche enables cleanly

With the timing fields above, clients can compute:

- per-tool duration
- grouped-row total tool duration by summing child `duration_ms`
- grouped-row wall interval by `min(started_at)` to `max(finished_at)`
- total tool time in a turn by summing tool rows that belong to the same turn

### 8.2 What this tranche does not solve precisely

This tranche does not add authoritative assistant-response timestamps.

Today:

- `agent.message_start`, `agent.message_delta`, and `agent.message_done` do not carry server timestamps
- persisted assistant rows only expose `created_at`, which is effectively the durable end boundary

So a client can compute exact tool time after this change, but only an approximate non-tool or response time.

Recommended terminology for this tranche:

- `tool_time_ms`: exact sum of tool durations
- `turn_wall_time_ms`: approximate total turn time, for example from user-message `created_at` to final assistant `created_at`
- `non_tool_time_ms`: `turn_wall_time_ms - tool_time_ms`

If product later wants precise server-clock response timing, that should be a separate follow-up that adds timestamps to assistant draft events or introduces a turn-summary contract.

## 9. Implementation Plan

### 9.1 Capture tool timing in `AgentService`

In `runAgentFlow(...)`:

1. capture `startedAt = new Date()` immediately before `emitToolCall(...)`
2. pass `startedAt` into `emitToolCall(...)` so the live event uses the same server timestamp
3. execute the tool
4. capture `finishedAt = new Date()` immediately after `toolExecutor.execute(...)` resolves
5. compute `durationMs`
6. pass all three into `recordToolResult(...)`

This keeps one authoritative timing source in the service process.

### 9.2 Persist timing only in `metadata`

`recordToolResult(...)` should:

- keep `content: JSON.stringify(execution.payload)` unchanged
- build `persistedMetadata = { ...execution.payload, started_at, finished_at, duration_ms }`
- insert `metadata: persistedMetadata`
- include those same timing fields in the top-level `agent.tool_result` event payload

### 9.3 Tests

Add or update service tests to verify:

- `agent.tool_call` carries `started_at`
- `agent.tool_result` carries `started_at`, `finished_at`, and `duration_ms`
- nested canonical `message.metadata` contains the same values
- canonical `message.content` does not grow the timing-only fields
- replay/history serialization continues to work unchanged

### 9.4 Documentation

Update:

- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- any mobile handoff doc that describes `agent.tool_call` and `agent.tool_result`

No database migration is required because the timing fields live in the existing JSONB metadata column.

## 10. Compatibility Notes

This is an additive contract change.

Existing clients that ignore unknown metadata or stream fields will continue to work.

Specifically:

- `/messages` shape does not change
- `agent.tool_call` and `agent.tool_result` retain their current required fields
- grouped summary rows remain entirely optional client behavior

The only subtle internal behavior change is that tool `message.content` and `message.metadata` will no longer be exact mirrors. That is intentional.

## 11. Alternatives Considered

### 11.1 Add only `duration_ms` to canonical metadata

Rejected as the preferred option.

It is enough for static display, but weaker for:

- live server-clock alignment
- grouped wall-interval rendering
- future debugging and traceability

### 11.2 Add timing to `message.content` and `message.metadata`

Rejected as the preferred option.

It is simpler mechanically, but it pollutes the model-facing replay payload with UI-only timing data because conversation replay currently reads from `message.content`.

### 11.3 Add a new grouped-tool backend event or grouped transcript row

Rejected.

The current transcript and stream model already gives the client enough identity and sequencing to group tool rows on its own.

## 12. Decision Summary

The mobile team’s request is directionally correct:

- grouped summary rows do not need a backend grouping contract
- the missing backend follow-up is authoritative tool timing

Recommended implementation:

- add `started_at`, `finished_at`, and `duration_ms` to canonical tool `message.metadata`
- add `started_at` to `agent.tool_call`
- add `started_at`, `finished_at`, and `duration_ms` to `agent.tool_result`
- keep timing out of tool `message.content` so transcript replay remains lean

That gives mobile accurate per-tool durations, reliable grouped-row totals, and server-aligned live timing without redesigning the rest of the chat contract.
