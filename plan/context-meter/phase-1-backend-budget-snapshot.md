# Phase 1: Backend Budget Snapshot

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Add a service-owned context budget snapshot helper using the Tier 0 model-agnostic estimate.

By the end of this phase:

- the backend can compute a context budget snapshot for a thread
- effective budget math matches automatic compaction
- checkpointed reconstruction is counted correctly
- unknown/degraded states are represented safely
- no browser-facing API response has changed yet unless explicitly chosen

## Scope

### In Scope

- snapshot and estimator TypeScript types
- Tier 0 estimate based on existing canonical message estimator
- effective budget fields
- checkpoint-aware conversation loading
- confidence/basis metadata
- focused unit tests

### Out Of Scope

- Tier 1 provider usage anchoring
- route response changes
- web UI changes
- provider token-count API calls
- local tokenizer dependencies

## Implementation Tasks

### Task 1: Define backend snapshot types

Add internal service types for:

- available snapshot
- unknown snapshot
- estimator result
- estimate basis and confidence

Keep the shape aligned with the API contract in [implementation-spec.md](./implementation-spec.md).

### Task 2: Reuse automatic compaction budget math

Use `resolveContextBudget(...)` as the source for:

- `context_window_tokens`
- `compaction_enabled`
- `compaction_threshold_ratio`
- `compaction_threshold_tokens`

Then compute:

```text
effective_budget_tokens =
  compaction_enabled && compaction_threshold_tokens
    ? compaction_threshold_tokens
    : context_window_tokens
remaining_context_tokens =
  max(0, effective_budget_tokens - estimated_input_tokens)
percent_of_context_budget =
  estimated_input_tokens / effective_budget_tokens
percent_of_model_window =
  estimated_input_tokens / context_window_tokens
```

The usable-context follow-on phases replace the disabled-compaction fallback with
`usable_input_window_tokens`. Until those phases land, the initial meter can use
`context_window_tokens` as the fallback.

If `context_window_tokens` is missing, return `status: "unknown"` with
`reason: "unknown_model_context_window"`.

### Task 3: Load model-visible context through the loader

Build the snapshot from the same reconstructed context used for provider calls:

- fresh system prompt
- latest completed checkpoint replacement history
- post-checkpoint transcript delta
- post-checkpoint provider ledger where the loader would replay it

Do not count visible transcript rows before the checkpoint except through replacement history.

### Task 4: Add Tier 0 estimate result

Use the existing character-based canonical message estimator as the baseline.

Set:

- `basis: "model_agnostic_estimate"`
- `confidence: "medium"` for plain text/provider-neutral content
- `confidence: "low"` if the reconstructed context contains modalities or provider payloads the estimator cannot model well

### Task 5: Mark stale during active turns

If the route/helper can see that a thread has an active agent turn and the snapshot is durable-only, return `stale: true`.

Do not expose raw active `conversation` arrays.

### Task 6: Add tests

Cover:

- no-checkpoint snapshot
- checkpointed snapshot
- unknown model context window
- auto-compaction disabled fallback behavior, updated by Phase 7 to use usable
  input window
- threshold parity with automatic compaction
- stale flag when active runtime state is present, if runtime state is injectable

## Files Likely Changed

- `service/src/agent/context-budget.ts`
- `service/src/agent/context-budget-estimator.ts`
- `service/src/agent/context-budget-snapshot.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/*.test.ts`
- `service/src/agent/agent.spec.md`

## Exit Criteria

- Backend helper returns stable available/unknown snapshots.
- Snapshot counts checkpointed context correctly.
- Tier 0 tests pass.
- No route or UI behavior changes accidentally.
