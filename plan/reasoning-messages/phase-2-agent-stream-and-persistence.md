# Phase 2: Agent Stream And Persistence

## Objective

Convert canonical provider reasoning events into live browser SSE events and
persist completed reasoning as `message.role = "reasoning"`.

## Scope

- Generate `llmCallId` before invoking the provider.
- Pass call/step metadata into `AgentModelRunner.invokeModel`.
- Track reasoning draft segments by provider output index.
- Emit live `agent.reasoning_start` and `agent.reasoning_delta`.
- Return completed reasoning segments from `invokeModel`.
- Extend `AgentRuntimeStateManager` with additive `draft_reasoning`.
- Add `AgentTranscriptWriter.recordReasoningSegment(...)`.
- Persist reasoning rows after successful provider invocation.
- Emit `agent.reasoning_done` with the persisted message.
- Clear unpersisted reasoning drafts on failed/canceled final events.
- Keep redacted reasoning hidden.

## Event Contract

### `agent.reasoning_start`

```json
{
  "turn_id": "01TURN...",
  "client_id": "uuidv7",
  "llm_call_id": "01CALL...",
  "index": 0,
  "provider": "openai",
  "provider_model": "gpt-5.5",
  "started_at": "2026-06-05T00:00:00.000Z"
}
```

### `agent.reasoning_delta`

```json
{
  "turn_id": "01TURN...",
  "client_id": "uuidv7",
  "delta": "I need to inspect the terminal state."
}
```

### `agent.reasoning_done`

```json
{
  "turn_id": "01TURN...",
  "client_id": "uuidv7",
  "message_id": "uuid",
  "text": "I need to inspect the terminal state.",
  "message": {
    "message_id": "uuid",
    "client_id": "uuidv7",
    "role": "reasoning",
    "display_role": "Reasoning",
    "content": "I need to inspect the terminal state.",
    "metadata": {
      "artifact_kind": "reasoning",
      "model_visible": false,
      "llm_call_id": "01CALL..."
    },
    "created_at": "2026-06-05T00:00:00.000Z"
  }
}
```

## Runtime Snapshot

Add:

```json
{
  "draft_reasoning": [
    {
      "client_id": "uuidv7",
      "text": "current draft",
      "llm_call_id": "01CALL...",
      "index": 0,
      "provider": "ds4",
      "provider_model": "deepseek-v4-flash",
      "updated_at": "2026-06-05T00:00:00.000Z"
    }
  ]
}
```

This is an additive `/agent/state` field.

## Persistence Metadata

Reasoning rows should include:

- `artifact_kind: "reasoning"`
- `model_visible: false`
- `turn_id`
- `llm_call_id`
- `step_index`
- `provider`
- `provider_model`
- `reasoning_index`
- `status: "succeeded"`
- `started_at`
- `finished_at`

No provider payloads.

## Expected Code Changes

- `service/src/agent/model-runner.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/runtime/agent-runtime-state.test.ts`
- `service/src/agent/model-runner.test.ts`
- `service/src/agent/transcript-writer.test.ts`

## Spec Files To Update

- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/routes/routes.spec.md`
- `docs/proto.md`

## Acceptance Criteria

- [ ] Reasoning-enabled provider calls emit start/delta events.
- [ ] Completed reasoning persists as `message.role = "reasoning"`.
- [ ] Done events include the persisted message row.
- [ ] Failed provider calls do not persist partial reasoning.
- [ ] Canceled turns clear draft reasoning.
- [ ] Redacted Anthropic thinking is not persisted as visible reasoning.
- [ ] Existing assistant text and tool event behavior remains unchanged.

## Tests

- Unit test runtime `draft_reasoning` serialization and cleanup.
- Unit test model runner reasoning stream handling with a fake provider.
- Unit test transcript writer reasoning row persistence and metadata.
- Agent flow test for a provider response containing reasoning plus final text.
- Agent flow test for a provider response containing reasoning plus tool call.

## Risks

- Persisting reasoning before a provider call succeeds can leave confusing rows
  for failed turns. Persist only after successful canonical response return.
- Creating `llmCallId` earlier changes call ID lifetime. The implementation
  should avoid recording `llm_call` rows until the same point as today unless a
  later failure-handling plan intentionally records failed calls.
