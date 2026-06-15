# Phase 3: Assistant Timing Stream And Persistence

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Add reliable per-message timing for assistant text rows across live stream,
runtime state, and persisted history.

By the end of this phase:

- assistant draft state has a stable `started_at`
- live assistant start/done events expose timing
- intermediate assistant rows persist duration metadata
- final assistant rows persist duration metadata

## Context

Assistant text is more complex than tool and reasoning timing because the
current runtime draft only stores `updated_at`. The service must carry one
assistant text start time from first text delta through final persistence.

Assistant rows can be:

- intermediate commentary before a tool call
- final answer text
- non-streamed fallback text normalized at the end of a model response

## Scope

### In Scope

- assistant draft `startedAt` internal runtime field
- `/agent/state.draft_assistant.started_at`
- `agent.message_start.started_at`
- `agent.message_done.started_at`
- `agent.message_done.finished_at`
- `agent.message_done.duration_ms`
- persisted assistant timing metadata for intermediate and final rows

### Out Of Scope

- exact turn duration
- backend grouped summaries
- assistant token-level timing
- estimating timing for legacy assistant rows

## Implementation Tasks

### Task 1: Track assistant draft start in runtime state

Extend `AgentRuntimeStateManager` assistant draft internals to store:

```ts
startedAt: Date;
updatedAt: Date;
```

`setDraftAssistant(...)` should preserve the existing `startedAt` for a draft
when updating text, similar to how reasoning drafts already preserve
`startedAt`.

### Task 2: Expose active assistant start in `/agent/state`

Extend the serialized snapshot:

```json
{
  "draft_assistant": {
    "client_id": "...",
    "text": "...",
    "started_at": "2026-06-09T20:00:10.000Z",
    "updated_at": "2026-06-09T20:00:12.000Z"
  }
}
```

Keep the field additive and nullable through the existing `draft_assistant:
null` behavior.

### Task 3: Emit assistant stream timing

Update `AgentModelRunner` so the first assistant text delta captures an
assistant `startedAt` before `agent.message_start` is emitted.

Recommended event additions:

```json
{
  "event": "agent.message_start",
  "data": {
    "turn_id": "01...",
    "client_id": "...",
    "started_at": "2026-06-09T20:00:10.000Z"
  }
}
```

When the assistant text stream completes, emit:

```json
{
  "event": "agent.message_done",
  "data": {
    "turn_id": "01...",
    "client_id": "...",
    "text": "...",
    "started_at": "2026-06-09T20:00:10.000Z",
    "finished_at": "2026-06-09T20:00:14.250Z",
    "duration_ms": 4250,
    "duration_source": "service_wall_clock"
  }
}
```

### Task 4: Return assistant timing from model runner

Extend the model-runner result to carry assistant timing alongside
`assistantClientId`, for example:

```ts
assistantTiming: AgentMessageTiming | null;
```

The `null` case covers responses that produce no assistant text draft.

### Task 5: Persist intermediate assistant timing

Thread assistant timing into `recordAssistantTextSegment(...)`.

For streamed intermediate commentary before a tool call, use the timing returned
by the model runner.

If no timing exists but visible text is persisted, create a zero-duration timing
at the persistence boundary rather than deriving timing from row order.

### Task 6: Persist final assistant timing

Thread assistant timing into `recordFinalAssistant(...)`.

For final streamed text, use the model-runner timing. For non-streamed final
text, use a zero-duration timing captured at the persistence boundary.

### Task 7: Keep draft clearing semantics intact

Continue clearing assistant drafts after the persisted assistant message is
emitted. The clear path should not erase timing before the writer receives it.

### Task 8: Add tests

Update unit tests to cover:

- runtime draft assistant preserves `started_at` across deltas
- `/agent/state` serializes draft assistant `started_at`
- `agent.message_start` includes `started_at`
- `agent.message_done` includes start/finish/duration/source
- intermediate assistant persisted metadata includes timing
- final assistant persisted metadata includes timing
- non-streamed assistant fallback uses honest zero-duration timing

## Files Likely Affected

- `service/src/agent/model-runner.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/runtime/agent-runtime-state.test.ts`
- `service/src/agent/transcript-writer.test.ts`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Multiple text blocks reuse one assistant client id and produce ambiguous timing | Medium | Medium | Keep v1 timing attached to the persisted assistant message as aggregated text |
| Non-streamed provider responses look artificially instant | Medium | Low | Use explicit zero-duration metadata rather than estimated values |
| Runtime state loses the original start time on each delta | Medium | High | Mirror reasoning draft preservation behavior |

## Exit Criteria

- Assistant live stream/state/history all expose consistent timing fields.
- Assistant timing does not depend on `message.created_at`.
- Existing assistant rendering and final event behavior remain compatible.
