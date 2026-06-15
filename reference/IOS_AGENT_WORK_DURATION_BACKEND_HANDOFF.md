# iOS Agent Work Duration Backend Handoff

**Status:** Backend request  
**Audience:** Backend, iOS, web, product  
**Last Updated:** 2026-06-09

## Summary

iOS now groups all intermediate agent-turn activity into a top-level `Worked` disclosure row:

- reasoning messages
- tool calls/results
- intermediate assistant output

For tool-only turns, iOS can still show `Worked for N` by summing durable tool `duration_ms` metadata. For mixed turns that include reasoning or intermediate assistant output, iOS currently falls back to `Worked` after reload because durable history does not provide an authoritative elapsed duration for the full agent turn.

This is primarily a backend data-shape gap. Tool duration is not the same as agent-turn elapsed duration, and iOS should not invent precise historical `Worked for N` copy from incomplete message timestamps.

## Current iOS Behavior

iOS uses this priority for the top-level agent-work duration:

1. Backend-authoritative agent-turn duration, when available.
2. Current-session observed elapsed time, while the app watched the turn stream live.
3. Summed tool durations only for pure tool-only groups.
4. No duration, displayed as `Worked`.

The regression users are seeing is expected under the current contract:

- before reasoning was grouped, many rows were tool-only, so summed tool durations produced `Worked for 1m 28s`
- after reasoning is grouped with tools, the same turn becomes mixed work
- iOS no longer treats summed tool duration as the full turn duration
- historical/reloaded mixed rows therefore display `Worked`

## Requested Backend Contract

Please persist a stable agent-turn timing envelope that iOS can read from durable message history.

Required fields:

- `turn_id`: stable id shared by every persisted message in one agent turn
- `turn_started_at`: timestamp for when the agent turn began
- `turn_finished_at`: timestamp for when the agent turn ended, when complete
- `turn_duration_ms`: elapsed wall-clock duration for the whole agent turn, when complete
- `turn_status`: `running`, `succeeded`, `failed`, or `cancelled`

These fields can be represented either:

- in each message metadata object, or
- in a separate turn summary object returned alongside `/messages`

The simplest iOS integration is repeated metadata on every message in the turn.

## Example Durable Messages

Reasoning message:

```json
{
  "message_id": "msg_reasoning_1",
  "client_id": "client_reasoning_1",
  "role": "reasoning",
  "content": "**Reviewing debug documents**",
  "metadata": {
    "turn_id": "turn_01",
    "turn_started_at": "2026-06-09T20:00:00.000Z",
    "turn_finished_at": "2026-06-09T20:01:28.000Z",
    "turn_duration_ms": 88000,
    "turn_status": "succeeded",
    "artifact_kind": "reasoning",
    "model_visible": false
  },
  "created_at": "2026-06-09T20:00:02.000Z"
}
```

Tool result message:

```json
{
  "message_id": "msg_tool_1",
  "client_id": "client_tool_1",
  "role": "tool",
  "content": "terminal.send",
  "metadata": {
    "turn_id": "turn_01",
    "turn_started_at": "2026-06-09T20:00:00.000Z",
    "turn_finished_at": "2026-06-09T20:01:28.000Z",
    "turn_duration_ms": 88000,
    "turn_status": "succeeded",
    "started_at": "2026-06-09T20:00:10.000Z",
    "finished_at": "2026-06-09T20:00:40.000Z",
    "duration_ms": 30000
  },
  "created_at": "2026-06-09T20:00:40.000Z"
}
```

Final assistant message:

```json
{
  "message_id": "msg_assistant_final_1",
  "client_id": "client_assistant_final_1",
  "role": "assistant",
  "content": "Done.",
  "metadata": {
    "turn_id": "turn_01",
    "turn_started_at": "2026-06-09T20:00:00.000Z",
    "turn_finished_at": "2026-06-09T20:01:28.000Z",
    "turn_duration_ms": 88000,
    "turn_status": "succeeded"
  },
  "created_at": "2026-06-09T20:01:28.000Z"
}
```

## Runtime State And Stream Alignment

For active turns, `/agent/state` and stream events already expose `turn_id` in several places. Please ensure the active-state contract can also expose:

- `turn_started_at`
- current `turn_status`

When the turn completes, the canonical persisted messages returned by `/messages` should include the final `turn_finished_at`, `turn_duration_ms`, and `turn_status`.

## iOS Consumption Plan

Once backend provides this metadata, iOS will:

1. Group work rows by `turn_id` when available.
2. Prefer `turn_duration_ms` for top-level `Worked for N`.
3. Use `turn_status` for failed/cancelled top-level badges.
4. Keep summed tool duration only as a compatibility fallback for historical tool-only rows.
5. Continue showing `Worked` for mixed historical rows when agent-turn duration is unavailable.

## Acceptance Criteria

1. Reloading a completed mixed turn with reasoning and tools shows the same `Worked for N` duration as it did while streaming live.
2. The duration represents full agent-turn wall-clock time, not summed tool execution time.
3. Every durable reasoning/tool/intermediate/final assistant message in the same agent turn shares the same `turn_id`.
4. A completed turn has `turn_duration_ms` and `turn_status`.
5. Failed and cancelled turns expose enough status metadata for iOS to show the top-level row badge consistently after reload.

## Open Questions

- Should `turn_duration_ms` include time spent streaming the final assistant answer, or only pre-final work? iOS currently labels the top-level row as agent work, so the product preference should be explicit.
- Should backend return a separate turn summary collection to avoid repeating metadata on each message?
- Are there legacy messages where `turn_id` cannot be backfilled? If so, iOS will keep chronological grouping and conservative `Worked` fallback for those rows.
