# Phase 2: Canonical Metadata And Agent Stream Rollout

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Ship the additive timing fields on the two existing backend surfaces that mobile already consumes:

- canonical persisted tool metadata
- live `agent.tool_call` and `agent.tool_result` events

By the end of this phase:

- canonical tool rows include timing in `message.metadata`
- `agent.tool_call` includes `started_at`
- `agent.tool_result` includes `started_at`, `finished_at`, and `duration_ms`
- replay payloads remain lean because `message.content` does not gain timing-only fields

## Context

The current service duplicates the execution payload into both:

- `message.content`
- `message.metadata`

That is workable today because the fields are all part of the current tool payload. This rollout intentionally breaks that mirror for timing fields because `conversation-loader.ts` replays tool history from `message.content`, and timing should not become part of model-facing replay context.

This phase therefore changes the persistence rule from:

- `content === metadata`

to:

- `content = execution payload`
- `metadata = execution payload + timing fields`

## Scope

### In Scope

- extending `agent.tool_call` payloads
- extending `agent.tool_result` payloads
- extending nested canonical tool `message.metadata`
- preserving `message.content` replay behavior

### Out Of Scope

- any new route or stream family
- changing `/agent/state.pending_tool`
- assistant timing

## Implementation Tasks

### Task 1: Extend `agent.tool_call`

Update `emitToolCall(...)` so the live event includes:

- `started_at`

Do not add `finished_at` or `duration_ms` here because the tool has not finished yet.

### Task 2: Extend `agent.tool_result`

Update `recordToolResult(...)` so the top-level event includes:

- `started_at`
- `finished_at`
- `duration_ms`

Keep the current fields untouched:

- `turn_id`
- `client_id`
- `call_id`
- `message_id`
- `name`
- `summary`
- `output`
- `output_bytes`
- `readiness`
- `truncated`
- `output_truncation_reason`
- `omitted_lines`
- `message`

### Task 3: Persist timing in `message.metadata`

When inserting the canonical tool row:

- keep `content: JSON.stringify(execution.payload)`
- create a `persistedMetadata` object that merges timing fields onto `execution.payload`
- insert `metadata: persistedMetadata`

The canonical persisted tool row should therefore expose timing under:

- `message.metadata.started_at`
- `message.metadata.finished_at`
- `message.metadata.duration_ms`

### Task 4: Preserve conversation replay behavior

Review `conversation-loader.ts` and confirm that replay continues to parse from `message.content`.

The implementation goal is that tool timing remains visible to transcript consumers but invisible to model replay.

Do not refactor replay to prefer `metadata` in this tranche unless a bug forces it.

### Task 5: Align serializer types

Update any service-local serialized message or event types so the additive timing fields are represented in the codebase and not left as untyped loose additions.

### Task 6: Keep the change additive for existing clients

Preserve backward compatibility:

- existing clients should still parse the current required fields
- new timing fields should be optional/additive from a consumer perspective

## Files Likely Affected

- `service/src/agent/transcript-writer.ts`
- `service/src/agent/contracts.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| The implementation accidentally adds timing to both `content` and `metadata` out of convenience | Medium | High | Test `message.content` shape explicitly and keep the design rule visible in review |
| A consumer expects `content` and `metadata` to remain exact mirrors | Medium | Medium | Document the intentional divergence and update first-party types/docs in Phase 3/4 |
| Nested canonical `message.metadata` and top-level `agent.tool_result` timing drift | Low | High | Derive both from the same `ToolExecutionTiming` input |

## Exit Criteria

- `agent.tool_call` exposes `started_at`.
- `agent.tool_result` exposes `started_at`, `finished_at`, and `duration_ms`.
- Canonical tool `message.metadata` exposes the same timing values.
- Canonical tool `message.content` remains replay-safe and timing-free.

