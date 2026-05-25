# Phase 0: Current State And Contract Lock

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Confirm the branch state and lock the budget snapshot contract before implementation begins.

By the end of this phase:

- current code paths that affect context counting are confirmed
- snapshot field names are fixed
- route/bootstrap ownership boundaries are chosen
- active-turn freshness expectations are explicit
- tests needed for later phases are identified

## Context

The design doc was written after automatic compaction landed. This phase prevents implementation drift by rechecking the actual branch before adding new budget APIs or UI.

Key assumptions to verify:

- `resolveContextBudget(...)` is still the compaction threshold source of truth
- `AgentConversationLoader` still returns checkpoint-aware reconstructed context and diagnostics
- provider usage is still persisted on `llm_call.usage`
- `/agent/state` is the right first-pass refresh surface
- web composer/model controls remain the right UI placement

## Scope

### In Scope

- reread the relevant service and web specs/files
- confirm the final API shape
- identify exact tests for phases 1-4
- confirm no schema migration is needed
- confirm no new SSE event is needed

### Out Of Scope

- adding estimator code
- changing route responses
- changing web UI
- adding provider token-count API calls
- adding manual compaction controls

## Implementation Tasks

### Task 1: Reconfirm service context-budget seams

Read and summarize current behavior for:

- `service/src/agent/context-budget.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/agent-service.ts`
- `service/src/llm/provider-ledger.ts`
- `service/src/llm/model-catalog.ts`
- `service/src/runtime/agent-runtime-state.ts`

If code drift invalidates design assumptions, update [implementation-spec.md](./implementation-spec.md) before code changes.

### Task 2: Lock snapshot field names

Confirm these first-pass names:

- `context_budget`
- `effective_budget_tokens`
- `estimated_input_tokens`
- `remaining_context_tokens`
- `percent_of_context_budget`
- `percent_of_model_window`
- `basis`
- `confidence`
- `stale`

Avoid using `remaining_before_compaction_tokens` as the durable API field because
auto-compaction-disabled mode uses the effective context budget. In the
usable-context follow-on phases, that effective limit is the usable input window,
not the hard provider context window.

### Task 3: Decide thread bootstrap inclusion

Find the thread detail/bootstrap route used by web and mobile.

Decision point:

- include `context_budget` only on `/agent/state` if bootstrap inclusion causes duplicated expensive work
- include `context_budget` on thread bootstrap if there is already a thread-owned loader path and it avoids an immediate second request

Record the decision in [implementation-spec.md](./implementation-spec.md) before Phase 3.

### Task 4: Lock active-turn behavior

Confirm the first pass does not expose raw in-memory `AgentService.runAgentFlow(...)` conversation state to the UI.

Required behavior:

- budget snapshots can be marked `stale: true` while an agent turn is active
- internal automatic compaction remains responsible for mid-turn budget checks before provider calls
- future runtime deltas must be narrow numeric estimates, not raw conversation arrays

### Task 5: Prepare fixtures

Identify or create test fixture helpers for:

- a no-checkpoint thread
- a checkpointed thread with replacement history and post-checkpoint messages
- a provider-ledger-backed assistant response with usage
- a latest provider call before checkpoint boundary
- unknown model context window
- auto-compaction disabled effective-limit behavior

## Tests To Prepare

- threshold parity with `resolveContextBudget(...)`
- no-checkpoint Tier 0 snapshot
- checkpointed Tier 0 snapshot
- unknown model snapshot
- stale active-turn snapshot
- non-owner route access returning `404`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Existing route/bootstrap shape is unclear | Medium | Medium | Keep first pass on `/agent/state` only if needed |
| Field names drift between backend and web | Medium | Medium | Lock names before implementation and update API types in Phase 3 |
| Active-turn expectations are overbuilt | Medium | Low | Mark stale and avoid runtime internals in first pass |

## Exit Criteria

- Branch assumptions are confirmed or updated.
- Snapshot field names are final for the first implementation.
- Bootstrap inclusion decision is recorded.
- Later phases have clear fixture/test targets.
