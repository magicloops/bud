# Design: Agent Message Work Duration Contract

Status: Draft

Audience: Backend, iOS, web, product

Last updated: 2026-06-09

## 1. Goal

Give first-party clients reliable backend timing for each persisted agent-created
message artifact, so clients can display grouped rows such as `Worked for
5m 43s` using whatever grouping model the UI chooses.

The immediate request is documented in
[`reference/IOS_AGENT_WORK_DURATION_BACKEND_HANDOFF.md`](../reference/IOS_AGENT_WORK_DURATION_BACKEND_HANDOFF.md).

This design covers:

- whether message timestamps are enough today
- which timing fields already exist on tool and reasoning rows
- a low-lift durable contract for per-message duration metadata
- how clients can calculate grouped durations without a new `agent_turn` table
- where a future turn table would still help

## 2. Verification Summary

The requested behavior is not fully possible today from `message.created_at`.

What exists today:

- Every persisted message row has `created_at`.
- Live agent events carry `turn_id`.
- Persisted assistant and reasoning rows include `metadata.turn_id`.
- Persisted reasoning rows include per-reasoning `started_at` and `finished_at`.
- Live tool events include `turn_id`, `started_at`, `finished_at`, and
  `duration_ms`.
- Persisted tool rows include `started_at`, `finished_at`, and `duration_ms`
  in `message.metadata`.

What is missing:

- Persisted tool rows do not currently include `metadata.turn_id`, so durable
  turn correlation is inconsistent across message roles.
- Persisted reasoning rows have start/finish timestamps but no `duration_ms`.
- Persisted assistant text rows do not include start/finish/duration metadata.
- Live assistant draft state exposes `updated_at`, but not `started_at`.
- `message.created_at` is a persistence timestamp. It is useful for ordering,
  but it is not a reliable work-start or work-finish boundary.

Conclusion: the backend should standardize service-owned timing metadata on
each agent-created message row. Clients can then sum durations or union
intervals for whichever reasoning/tool/output rows they group.

## 3. Decision

Do not add a durable `agent_turn` table for the first implementation.

Instead, make individual persisted message rows the durable timing unit by
normalizing these metadata fields on every agent-created artifact that
represents work:

```json
{
  "metadata": {
    "turn_id": "01...",
    "started_at": "2026-06-09T20:00:10.000Z",
    "finished_at": "2026-06-09T20:00:14.250Z",
    "duration_ms": 4250,
    "duration_source": "service_wall_clock"
  }
}
```

Required fields:

| Field | Meaning |
| --- | --- |
| `turn_id` | Agent turn id when known; useful for correlation but not required for client grouping |
| `started_at` | Service timestamp when this message artifact began producing or executing work |
| `finished_at` | Service timestamp when this message artifact completed |
| `duration_ms` | `max(0, finished_at - started_at)` |
| `duration_source` | Stable source label; v1 should use `service_wall_clock` |

This is a JSON metadata-only contract. It does not require a schema migration or
server-side turn reconciliation logic.

## 4. Message-Type Semantics

### 4.1 Tool Messages

Tool messages are closest to the target contract today.

Current behavior:

- `agent.tool_call` emits `turn_id` and `started_at`.
- `agent.tool_result` emits `turn_id`, `started_at`, `finished_at`, and
  `duration_ms`.
- The persisted tool message metadata includes `started_at`, `finished_at`, and
  `duration_ms`.

Needed change:

- Add `turn_id` to persisted tool `message.metadata`.
- Add `duration_source: "service_wall_clock"` to persisted metadata and the
  emitted message payload.

Timing boundary:

- `started_at`: immediately before the service emits `agent.tool_call` and
  starts executing the tool.
- `finished_at`: immediately after tool execution resolves and before the
  persisted tool result is written.

This timing includes service-side waits for terminal settlement, web-view
operations, and `ask_user_questions` waits. If product later wants to exclude
human wait time for `ask_user_questions`, add a separate paused/active timing
field for that tool type rather than changing the meaning of `duration_ms`.

### 4.2 Reasoning Messages

Reasoning rows already persist most of the needed information.

Current behavior:

- `agent.reasoning_start` emits `started_at`.
- Runtime state exposes active reasoning `started_at` and `updated_at`.
- Persisted reasoning metadata includes `started_at` and `finished_at`.

Needed change:

- Add `duration_ms`.
- Add `duration_source: "service_wall_clock"`.

Timing boundary:

- `started_at`: first provider reasoning-start or reasoning-delta timestamp for
  that reasoning block.
- `finished_at`: provider reasoning-done timestamp, or the time the final
  reasoning block is normalized if the provider does not stream an explicit
  done event.

### 4.3 Assistant Text Messages

Assistant text rows need the most work.

Current behavior:

- Live assistant streaming emits `agent.message_start`,
  `agent.message_delta`, and `agent.message_done`.
- Runtime state exposes active assistant draft `updated_at`.
- Persisted intermediate/final assistant rows include `turn_id`, but no
  start/finish/duration metadata.

Needed change:

- Track assistant draft `started_at` in the model runner/runtime state.
- Include `started_at` on `agent.message_start`.
- Include `started_at`, `finished_at`, and `duration_ms` on
  `agent.message_done`.
- Persist the same fields on intermediate and final assistant message metadata.
- Add `duration_source: "service_wall_clock"`.

Timing boundary:

- `started_at`: when the first assistant text delta for that assistant message
  starts, using the service timestamp captured before emitting
  `agent.message_start`.
- `finished_at`: when the assistant text stream for that message is complete,
  before persisting the assistant row.

Fallback:

- If a provider returns a non-streamed final text block without any live
  assistant draft event, set both timestamps from the service-side
  normalization/persist path and allow `duration_ms` to be `0`. This is more
  honest than deriving duration from unrelated row timestamps.

### 4.4 User And System Messages

User and system rows do not need work-duration metadata for this request.

They may still have `created_at` for ordering. Clients should not treat user or
system `created_at` as work duration boundaries.

## 5. Client Calculation Guidance

Clients should treat message timing metadata as the source of truth when
building collapsed summaries.

Recommended calculation:

1. Select the message rows included in the collapsed group.
2. For rows with `duration_ms`, use that value directly.
3. For rows with `started_at` and `finished_at` but no `duration_ms`, compute
   `max(0, finished_at - started_at)` as a legacy compatibility fallback.
4. Ignore rows without message timing metadata for duration math.

For product copy:

- If the UI wants additive "work units", sum `duration_ms`.
- If the UI wants elapsed wall-clock time for a group, compute the union of
  `[started_at, finished_at]` intervals so overlapping artifacts are not double
  counted.

The backend should provide both timestamps and duration so clients can choose
without relying on `created_at` heuristics.

## 6. Live Recovery Contract

The same fields should be available while a turn is still active.

Existing live support:

- `pending_tool.started_at` already exists in `/agent/state`.
- Active reasoning drafts already expose `started_at` and `updated_at`.

Needed live additions:

- Add `started_at` to `draft_assistant` in `/agent/state`.
- Add `started_at` to `agent.message_start`.
- Add `started_at`, `finished_at`, and `duration_ms` to
  `agent.message_done`.
- Ensure emitted `message` objects for assistant/reasoning/tool rows include the
  same metadata that `/messages` will return after reload.

This lets iOS use one renderer path for live streams, app relaunch, pagination,
and reconnect bootstrap.

## 7. Failure, Cancel, And Resume Boundaries

Per-message duration is intentionally smaller than turn status.

V1 behavior:

- If a turn fails halfway through, completed reasoning/tool/assistant rows keep
  their own durations.
- If a turn is canceled while a tool is active and a tool result row is
  persisted, that tool row should use its actual start/cancel finish boundary.
- If cancellation or provider failure happens before a row is persisted, there
  may be no durable message duration for the in-flight artifact.
- If a future resume flow reuses a previous conversation context, newly
  persisted rows get their own durations. The client does not need to know
  whether the backend considers this a resumed turn.

This avoids forcing the near-term design to answer turn-level lifecycle
questions such as durable failure state, stale-running reconciliation, or
resumption semantics.

Future escalation:

- If product needs a durable turn-level status after reload, especially for
  failed/canceled turns with no final assistant row, add a separate
  `agent_turn` source of truth later.
- If product needs exact turn wall-clock duration independent of message
  overlap, add a durable turn envelope later.
- The per-message timing fields should remain useful even if that turn table is
  added.

## 8. Backfill And Compatibility

This is additive for new rows.

Historical behavior:

- Existing tool rows can already supply `duration_ms`.
- Existing reasoning rows can derive duration from `started_at` and
  `finished_at`.
- Existing assistant rows generally cannot supply trustworthy duration.
- Existing `created_at` should remain ordering metadata only.

Do not backfill assistant durations from neighboring message timestamps unless
the value is labeled as estimated and product explicitly accepts that weaker
quality.

Recommended client fallback order:

1. Use `metadata.duration_ms`.
2. Compute from `metadata.started_at` and `metadata.finished_at`.
3. Omit duration for that row.
4. Show plain `Worked` when a collapsed legacy group has no timed rows.

## 9. Implementation Plan

### Phase 1: Normalize Metadata Helpers

1. Add a shared helper for service wall-clock message timing metadata.
2. Reuse the existing tool timing helper where possible.
3. Keep field names snake_case at the API boundary.

### Phase 2: Persist Missing Metadata

1. Add `turn_id` and `duration_source` to tool message metadata.
2. Add `duration_ms` and `duration_source` to reasoning message metadata.
3. Thread assistant text start/finish timestamps from the model runner into
   `recordAssistantTextSegment(...)` and `recordFinalAssistant(...)`.
4. Persist assistant `started_at`, `finished_at`, `duration_ms`, and
   `duration_source`.

### Phase 3: Live Stream And State

1. Track assistant draft `started_at` in runtime state.
2. Add assistant timing fields to `agent.message_start`,
   `agent.message_done`, and `/agent/state.draft_assistant`.
3. Verify emitted message payloads match `/messages` history payloads.

### Phase 4: Specs And Client Types

1. Update `docs/proto.md` for message metadata timing and assistant stream
   timing fields.
2. Update service agent/runtime/routes specs.
3. Update web and iOS API types/fixtures.
4. Keep the future `agent_turn` table as a separate design/implementation item.

## 10. Validation

Minimum backend tests:

- Tool rows persist `turn_id`, `started_at`, `finished_at`, `duration_ms`, and
  `duration_source`.
- Reasoning rows persist `duration_ms` and `duration_source`.
- Assistant intermediate rows persist timing metadata.
- Assistant final rows persist timing metadata.
- `/agent/state.draft_assistant` exposes `started_at`.
- `agent.message_start` and `agent.message_done` expose assistant timing.
- `/messages` returns the same persisted metadata after reload.

Minimum mobile-facing fixtures:

- mixed reasoning + tool + assistant output group can calculate duration after
  reload
- tool-only legacy group still works via existing `duration_ms`
- reasoning-only legacy row can calculate duration from start/finish
- legacy assistant-only row omits duration rather than inventing one

## 11. Decision Summary

The current backend supports per-tool timing and partial reasoning timing, but
not reliable duration metadata for every agent-created message.

The recommended near-term path is:

- keep durations at the message level
- persist `started_at`, `finished_at`, `duration_ms`, and `duration_source` on
  tool, reasoning, and assistant rows
- add missing durable `turn_id` to tool rows for correlation
- expose assistant start/finish timing in live stream/state
- let clients calculate group totals based on the rows they actually collapse
- defer a durable `agent_turn` table until product needs turn-level status or
  exact turn wall-clock semantics
