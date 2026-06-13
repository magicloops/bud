# Phase 2: Tool And Reasoning Metadata

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Fill the low-risk persisted metadata gaps for tool and reasoning rows.

By the end of this phase:

- persisted tool rows include durable `turn_id`
- persisted tool rows include `duration_source`
- persisted reasoning rows retain `turn_id` and include `duration_ms` plus `duration_source`
- existing tool/reasoning stream behavior remains compatible

## Context

Tools and reasoning already have clear timing boundaries:

- tool timing is captured around tool execution in `AgentService`
- reasoning start/finish timestamps are captured in `AgentModelRunner`

This phase should not change the timing boundaries. It only normalizes the
durable metadata shape.

## Scope

### In Scope

- tool `message.metadata.turn_id`
- tool `message.metadata.duration_source`
- reasoning `message.metadata.duration_ms`
- reasoning `message.metadata.duration_source`
- reasoning `message.metadata.turn_id`
- test updates for persisted rows and emitted nested messages

### Out Of Scope

- assistant text timing
- `/agent/state.draft_assistant`
- new route shapes
- backfilling historic rows

## Implementation Tasks

### Task 1: Add `turn_id` to tool metadata

In `AgentTranscriptWriter.recordToolResult(...)`, include:

```ts
turn_id: turnId
```

in the persisted metadata object.

Keep the existing top-level `agent.tool_result.data.turn_id` unchanged.

### Task 2: Add `duration_source` to tool metadata

Serialize tool timing through the shared timing serializer from Phase 1 so the
metadata includes:

```json
{
  "started_at": "...",
  "finished_at": "...",
  "duration_ms": 3250,
  "duration_source": "service_wall_clock"
}
```

If live `agent.tool_result` top-level timing uses the same serializer, adding
`duration_source` at the top level is acceptable and should be documented as an
additive field. The nested `message.metadata.duration_source` is required.

### Task 3: Add reasoning duration metadata

In `AgentTranscriptWriter.recordReasoningSegment(...)`, build timing from the
existing `startedAt` and `finishedAt` args and merge the serialized timing into
metadata.

Keep existing reasoning metadata fields:

- `started_at`
- `finished_at`
- `turn_id`
- `llm_call_id`
- `step_index`
- provider/model fields

### Task 4: Keep replay payloads unchanged

Do not add timing fields to model-visible replay content. Tool timing belongs in
`message.metadata`, not in the JSON string stored as tool `message.content`.
Reasoning rows remain display-only and model-invisible.

### Task 5: Add focused tests

Extend transcript-writer tests to assert:

- tool persisted metadata contains `turn_id`
- tool persisted metadata contains `duration_source`
- tool `message.content` is unchanged
- reasoning persisted metadata contains `duration_ms`
- reasoning persisted metadata contains `duration_source`
- reasoning persisted metadata contains `turn_id`

## Files Likely Affected

- `service/src/agent/transcript-writer.ts`
- `service/src/agent/contracts.ts`
- `service/src/agent/transcript-writer.test.ts`
- `service/src/agent/agent.spec.md`

## Compatibility Notes

- Fields are additive under `message.metadata`.
- Legacy rows may be missing `turn_id` or `duration_source`.
- Clients should continue fallback behavior for older rows.

## Exit Criteria

- Tool and reasoning rows share the same work metadata shape: `turn_id`,
  `started_at`, `finished_at`, `duration_ms`, and `duration_source`.
- No assistant code paths are modified in this phase.
- Automated coverage proves the replay payload remains timing-free.
