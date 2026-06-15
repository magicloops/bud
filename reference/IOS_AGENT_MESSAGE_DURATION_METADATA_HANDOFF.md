# iOS Agent Message Duration Metadata Handoff

**Status:** Backend implemented, mobile-ready contract review  
**Audience:** iOS, backend, web, product  
**Last Updated:** 2026-06-09

## Summary

Backend now exposes service-owned duration metadata on each new agent-created
work message so mobile can calculate `Worked for N` based on whatever rows it
chooses to group.

This intentionally does **not** add a durable `agent_turn` table or a backend
turn-summary row. Instead, new tool, reasoning, intermediate assistant, and
final assistant rows use the same durable metadata shape under
`message.metadata`.

## Related Docs

- Original iOS request: [IOS_AGENT_WORK_DURATION_BACKEND_HANDOFF.md](./IOS_AGENT_WORK_DURATION_BACKEND_HANDOFF.md)
- Protocol source: [../docs/proto.md](../docs/proto.md)
- Backend design: [../design/agent-message-work-duration-contract.md](../design/agent-message-work-duration-contract.md)
- Implementation plan: [../plan/message-duration-metadata/implementation-spec.md](../plan/message-duration-metadata/implementation-spec.md)

## Durable Message Metadata Contract

New agent-created work rows may include:

```json
{
  "turn_id": "01TURN...",
  "started_at": "2026-06-09T20:00:10.000Z",
  "finished_at": "2026-06-09T20:00:14.250Z",
  "duration_ms": 4250,
  "duration_source": "service_wall_clock"
}
```

This shape applies to:

- `role: "tool"` rows
- `role: "reasoning"` rows
- intermediate `role: "assistant"` rows, usually
  `metadata.segment_kind: "intermediate"`
- final `role: "assistant"` rows, usually `metadata.segment_kind: "final"`

Rules:

- `duration_ms` is per message/artifact, not a guaranteed whole-turn duration.
- `duration_source` is currently always `"service_wall_clock"`.
- `duration_ms` is calculated as `max(0, finished_at - started_at)`.
- `message.created_at` remains ordering/persistence metadata, not duration
  metadata.
- `message.content` remains the model replay or display payload and does not
  include timing-only fields.
- Legacy rows may omit some or all timing metadata; mobile should ignore
  missing durations rather than estimating from neighboring timestamps.

## Durable Examples

Reasoning row:

```json
{
  "message_id": "msg_reasoning_1",
  "client_id": "client_reasoning_1",
  "role": "reasoning",
  "display_role": "Reasoning",
  "content": "I should inspect the terminal state.",
  "metadata": {
    "artifact_kind": "reasoning",
    "model_visible": false,
    "turn_id": "01TURN...",
    "llm_call_id": "01LLM...",
    "started_at": "2026-06-09T20:00:01.000Z",
    "finished_at": "2026-06-09T20:00:04.000Z",
    "duration_ms": 3000,
    "duration_source": "service_wall_clock"
  },
  "created_at": "2026-06-09T20:00:04.100Z"
}
```

Tool row:

```json
{
  "message_id": "msg_tool_1",
  "client_id": "client_tool_1",
  "role": "tool",
  "display_role": "Tool",
  "content": "{\"tool\":\"terminal.send\",\"call_id\":\"call_1\"}",
  "metadata": {
    "tool": "terminal.send",
    "call_id": "call_1",
    "turn_id": "01TURN...",
    "started_at": "2026-06-09T20:00:10.000Z",
    "finished_at": "2026-06-09T20:00:40.000Z",
    "duration_ms": 30000,
    "duration_source": "service_wall_clock"
  },
  "created_at": "2026-06-09T20:00:40.100Z"
}
```

Intermediate assistant row:

```json
{
  "message_id": "msg_assistant_intermediate_1",
  "client_id": "client_assistant_1",
  "role": "assistant",
  "display_role": "Bud Agent",
  "content": "I will inspect the terminal first.",
  "metadata": {
    "status": "succeeded",
    "turn_id": "01TURN...",
    "segment_kind": "intermediate",
    "assistant_phase": "commentary",
    "started_at": "2026-06-09T20:00:05.000Z",
    "finished_at": "2026-06-09T20:00:06.250Z",
    "duration_ms": 1250,
    "duration_source": "service_wall_clock"
  },
  "created_at": "2026-06-09T20:00:06.300Z"
}
```

Final assistant row:

```json
{
  "message_id": "msg_assistant_final_1",
  "client_id": "client_assistant_final_1",
  "role": "assistant",
  "display_role": "Bud Agent",
  "content": "Done.",
  "metadata": {
    "status": "succeeded",
    "turn_id": "01TURN...",
    "segment_kind": "final",
    "assistant_phase": "final_answer",
    "started_at": "2026-06-09T20:01:00.000Z",
    "finished_at": "2026-06-09T20:01:02.500Z",
    "duration_ms": 2500,
    "duration_source": "service_wall_clock"
  },
  "created_at": "2026-06-09T20:01:02.550Z"
}
```

## Live Stream And Runtime Contract

The durable contract above is the canonical reload path. Live stream/runtime
fields are additive so mobile can show current-session elapsed time before the
canonical row is persisted.

Assistant draft start:

```json
{
  "event": "agent.message_start",
  "data": {
    "turn_id": "01TURN...",
    "client_id": "client_assistant_1",
    "started_at": "2026-06-09T20:00:05.000Z"
  }
}
```

Assistant draft done:

```json
{
  "event": "agent.message_done",
  "data": {
    "turn_id": "01TURN...",
    "client_id": "client_assistant_1",
    "text": "I will inspect the terminal first.",
    "started_at": "2026-06-09T20:00:05.000Z",
    "finished_at": "2026-06-09T20:00:06.250Z",
    "duration_ms": 1250,
    "duration_source": "service_wall_clock"
  }
}
```

Runtime state while assistant text is streaming:

```json
{
  "active": true,
  "turn_id": "01TURN...",
  "phase": "streaming_message",
  "draft_assistant": {
    "client_id": "client_assistant_1",
    "text": "I will inspect",
    "started_at": "2026-06-09T20:00:05.000Z",
    "updated_at": "2026-06-09T20:00:05.500Z"
  }
}
```

Existing live tool timing remains available:

- `agent.tool_call.started_at`
- `agent.tool_result.started_at`
- `agent.tool_result.finished_at`
- `agent.tool_result.duration_ms`
- `agent.tool_result.duration_source`
- `/agent/state.pending_tool.started_at`

Existing live reasoning state remains available:

- `agent.reasoning_start.started_at`
- `/agent/state.draft_reasoning[].started_at`
- persisted reasoning timing on `agent.reasoning_done.message.metadata`

## Recommended Mobile Consumption

For a collapsed `Worked` group:

1. Select the rows mobile wants to display inside that collapsed group.
2. Prefer rows with `metadata.duration_ms` and
   `metadata.duration_source == "service_wall_clock"`.
3. If the intended copy is additive work time, sum `duration_ms` for included
   rows.
4. If the intended copy is elapsed wall-clock for overlapping intervals,
   compute an interval union from `started_at` / `finished_at`.
5. Ignore rows without timing metadata.
6. Keep the existing legacy fallback for historical tool-only groups.
7. Avoid deriving historical duration from `message.created_at`.

For current-session active turns:

- use live `started_at` fields to render an updating elapsed timer if desired
- reconcile to the persisted `message.metadata` values once canonical rows
  arrive through `agent.message`, `agent.tool_result`, or
  `agent.reasoning_done`
- after reconnect/resync, prefer `/messages` plus `/agent/state` over local
  timer history

## What Changed In Backend/Web

- Added shared service wall-clock timing helpers.
- Tool rows now persist `metadata.turn_id` and `metadata.duration_source`.
- Reasoning rows now persist `metadata.duration_ms` and
  `metadata.duration_source`, while retaining `metadata.turn_id`.
- Intermediate and final assistant rows now persist the same timing metadata
  shape.
- `agent.message_start` now includes `started_at`.
- `agent.message_done` now includes `started_at`, `finished_at`,
  `duration_ms`, and `duration_source`.
- `/agent/state.draft_assistant` now includes `started_at`.
- First-party web API types and stream parser accept the additive fields.
- `tsx` is now a web dev dependency so focused Node tests can use
  `node --import tsx`.

## Validation Status

Automated checks passed:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/agent/contracts.test.ts src/agent/transcript-writer.test.ts src/agent/model-runner.test.ts src/runtime/agent-runtime-state.test.ts src/agent/agent-service.test.ts
```

Result: 42 service tests passed.

```bash
pnpm --dir /Users/adam/bud/web exec node --import tsx --test src/features/threads/thread-message-state.test.ts
```

Result: 11 web tests passed.

Manual live validation is still pending. Suggested manual checks:

- stream one turn with reasoning, a tool call, and assistant text
- inspect live `agent.message_start` / `agent.message_done`
- inspect live `agent.tool_result`
- inspect `agent.reasoning_done.message.metadata`
- reload and inspect `/api/threads/:thread_id/messages`
- verify mobile grouping can calculate a duration from persisted metadata

## Remaining Gaps / Non-Goals

These were intentionally not implemented in this tranche:

- no durable `agent_turn` table
- no backend turn-summary collection returned alongside `/messages`
- no exact whole-turn wall-clock duration
- no durable `turn_status` repeated on each message
- no active-vs-paused split for `ask_user_questions`
- no backfill for legacy rows without timing metadata

`ask_user_questions` tool duration still includes human wait time. If product
wants `Worked for N` to exclude paused human input, that needs a separate turn
or pause/resume design.

## Handoff Recommendation

Mobile can integrate against the per-message metadata contract now. If mobile
needs exact reload-stable whole-turn status/duration, that should be tracked as
a follow-up backend design rather than inferred from these per-message fields.
