# Phase 2: Conversation Loader Checkpoint Boundary

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented, provider-switch checkpoint tests pending

---

## Objective

Teach conversation reconstruction to honor the latest completed checkpoint.

By the end of this phase:

- no-checkpoint reconstruction behaves exactly as before
- checkpointed reconstruction uses fresh system prompt plus checkpoint replacement history plus post-checkpoint delta
- same-provider ledger replay starts after the checkpoint boundary
- provider-switch fallback uses canonical post-checkpoint transcript rows
- diagnostics make checkpointed reconstruction observable

## Scope

### In Scope

- loading the latest completed checkpoint inside `AgentConversationLoader`
- filtering transcript rows after the checkpoint message boundary
- filtering provider ledger rows after the checkpoint LLM-call boundary
- adding reconstruction diagnostics
- tests for checkpointed and no-checkpoint reconstruction

### Out Of Scope

- creating checkpoints
- token budget estimation
- automatic compaction triggers
- client-visible stream events

## Implementation Tasks

### Task 1: Extend loader dependencies

Inject or instantiate the checkpoint repository in `AgentConversationLoader`.

The loader should resolve the latest completed checkpoint before loading transcript rows or provider ledger rows.

### Task 2: Reconstruct in checkpoint-aware order

When no completed checkpoint exists, preserve existing behavior.

When a checkpoint exists, construct:

1. the normal current Bud Agent system prompt
2. `checkpoint.replacement_history`
3. durable post-checkpoint transcript rows
4. post-checkpoint provider-ledger rows when same-provider replay is valid

The replacement history must not contain the base system prompt. If a bad checkpoint row contains a system prompt anyway, log a degraded reconstruction warning and filter or tolerate it according to the local canonical message rules.

### Task 3: Filter transcript rows by boundary

Update the stored-row query so it can load only rows after:

- `compacted_through_message_created_at`
- `compacted_through_message_id`

Boundary rule:

```text
(message.created_at, message.message_id) > (boundary_created_at, boundary_message_id)
```

If a checkpoint has no message boundary, treat it as compacting no durable messages and load all rows.

### Task 4: Filter provider ledger rows by boundary

Update provider ledger loading so same-provider replay considers only calls after:

- `compacted_through_llm_call_created_at`
- `compacted_through_llm_call_id`

Boundary rule:

```text
(llm_call.created_at, llm_call.llm_call_id) > (boundary_created_at, boundary_llm_call_id)
```

Compaction summarization calls should not appear in `llm_call` during the first tranche. If future rows use a compaction request mode, this loader must filter them out explicitly.

### Task 5: Preserve provider-switch fallback

When target provider/model settings are incompatible with provider-native replay, keep the existing canonical transcript fallback, but apply the same checkpoint message boundary.

Expected result:

- old provider-native reasoning/tool output before the checkpoint is summarized, not replayed
- visible transcript rows after the checkpoint still feed provider-switch fallback

### Task 6: Add diagnostics

Extend loader diagnostics with:

- `checkpoint_id`
- `checkpoint_created_at`
- `replacement_history_message_count`
- `compacted_through_message_id`
- `compacted_through_llm_call_id`
- `checkpoint_provider_native_replay_start`
- `checkpoint_applied: boolean`

Avoid logging raw summary or replacement-history text in normal logs.

## Files Likely Affected

- `service/src/agent/conversation-loader.ts`
- `service/src/agent/context-checkpoint-repository.ts`
- `service/src/llm/provider-ledger.ts`
- `service/src/agent/agent.spec.md`
- `service/src/llm/llm.spec.md`

## Tests

Add or update tests for:

- no-checkpoint loader output remains unchanged
- latest completed checkpoint prepends replacement history after the system prompt
- failed checkpoint is ignored
- message rows at or before the boundary are excluded
- message rows after the boundary are included
- same-provider ledger rows at or before the boundary are excluded
- same-provider ledger rows after the boundary are included
- provider-switch fallback applies the checkpoint message boundary
- diagnostics include checkpoint metadata without raw summary text

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Loader duplicates compacted context by mixing old ledger rows with summary | Medium | High | Gate Phase 2 on direct provider-ledger boundary tests |
| Boundary tie-breaker is not deterministic | Medium | High | Use `(created_at, id)` ordering consistently in queries and tests |
| Replacement history shape drifts from canonical messages | Medium | Medium | Validate checkpoint JSON before using it and log degraded rows |
| Diagnostics leak sensitive summary data | Low | High | Log ids/counts only, not content |

## Exit Criteria

- Loader behavior is checkpoint-aware and tested.
- Existing no-checkpoint behavior remains stable.
- Provider ledger replay starts after the checkpoint boundary.
- Reconstruction diagnostics identify whether a checkpoint was applied.
