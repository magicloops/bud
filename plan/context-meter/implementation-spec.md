# Implementation Spec: Conversation Context Budget Meter

**Status**: Planned
**Created**: 2026-05-24
**Design Doc**: [../../design/conversation-context-budget-meter.md](../../design/conversation-context-budget-meter.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 0**: [phase-0-current-state-and-contract-lock.md](./phase-0-current-state-and-contract-lock.md)
**Phase 1**: [phase-1-backend-budget-snapshot.md](./phase-1-backend-budget-snapshot.md)
**Phase 2**: [phase-2-provider-usage-plus-delta.md](./phase-2-provider-usage-plus-delta.md)
**Phase 3**: [phase-3-api-and-agent-state-contract.md](./phase-3-api-and-agent-state-contract.md)
**Phase 4**: [phase-4-web-context-meter-ui.md](./phase-4-web-context-meter-ui.md)
**Phase 5**: [phase-5-validation-docs-and-rollout.md](./phase-5-validation-docs-and-rollout.md)

---

## Context

Bud now has automatic context compaction that keeps long-running threads below a selected model's context threshold. The service has:

- model catalog context windows
- automatic compaction enablement and threshold ratio configuration
- a character-based context estimate used as a guardrail
- checkpoint-aware conversation reconstruction
- provider usage persistence on `llm_call.usage`

Users still cannot see how close a thread is to the next automatic compaction point. A visible meter should report the model-visible context budget for the current thread, accounting for the latest compaction checkpoint, selected model, effective threshold, and best available token estimate.

## Objective

Add a context meter that shows remaining usable context for a conversation before automatic compaction.

Specifically:

- compute a service-owned, checkpoint-aware `context_budget` snapshot
- use the same compaction threshold math as automatic compaction
- expose the snapshot through authenticated thread/agent state APIs
- show a compact meter in the web workbench
- use a model-agnostic estimate everywhere as the baseline
- improve estimates with provider usage plus delta when a valid anchor exists
- avoid adding a new SSE event family in the first pass
- avoid coupling the UI to raw in-memory agent-loop internals

## Fixed Decisions

These decisions are fixed for the initial implementation:

- The primary UI shows compaction-budget usage, not raw model-window usage.
- `AGENT_AUTO_COMPACTION_RATIO` remains capped at `0.9`.
- Clients must read the effective threshold from the service; no client hardcoding of 90%.
- If auto-compaction is disabled but the model window is known, the effective meter limit is the full model context window.
- No dedicated `context.budget` SSE event ships in the first pass.
- The meter can lag while an agent turn is active; internal mid-turn compaction still counts in-memory loop state before later provider calls.
- Tier 0 model-agnostic counting ships first.
- Tier 1 uses real provider response usage, including output tokens that may become replayed assistant context.
- Provider token-count APIs are deferred.
- Local tokenizer adapters are deferred.
- Manual compaction UI or `/compact` handling is deferred.
- Visual UI uses percentages; hover/details may show rounded token values such as `312k`.

## Success Criteria

- [ ] A thread with no checkpoint reports context usage from the reconstructed model-visible request, not from client-side transcript counting.
- [ ] A checkpointed thread reports usage from fresh system prompt plus checkpoint replacement history plus post-checkpoint deltas.
- [ ] The reported threshold matches `resolveContextBudget(...)` and automatic compaction behavior.
- [ ] A model with unknown context window returns an unknown/degraded snapshot rather than crashing.
- [ ] Tier 1 estimates include provider output-token usage where available.
- [ ] Tier 1 anchors invalidate on provider, model, reasoning, checkpoint, or request-shape changes.
- [ ] `/agent/state` returns `context_budget` only after ownership is resolved.
- [ ] Web renders normal, elevated, near-threshold, unknown, stale, and degraded states.
- [ ] No new SSE event is required for the first web implementation.

## Non-Goals

- exact token accounting for every provider and modality
- provider token-count API calls in the first pass
- local tokenizer dependencies
- charging/cost estimates
- continuously live token accounting inside every tool loop
- manual compaction action
- changing visible transcript semantics
- database persistence for budget snapshots
- Bud daemon or terminal protocol changes

## Proposed Architecture

### Service-Owned Snapshot

Add a backend helper that computes a client-safe budget snapshot. The helper should:

1. resolve the selected/effective model and provider
2. resolve the context budget through the existing compaction budget helper
3. load checkpoint-aware model-visible context through the same conversation-loader path the agent uses
4. choose the best available counting tier
5. normalize percentages and remaining-token fields
6. return a narrow JSON object with no raw prompt, summary, or provider ledger contents

Candidate module split:

- `service/src/agent/context-budget.ts` keeps threshold and baseline token helpers
- `service/src/agent/context-budget-estimator.ts` owns Tier 0 and Tier 1 estimate selection
- `service/src/agent/context-budget-snapshot.ts` or a route-local service helper owns authorization-safe snapshot orchestration

If a smaller edit is cleaner, these helpers may start in `context-budget.ts`, but the implementation should avoid mixing route authorization, conversation loading, and token arithmetic in one function.

### Snapshot Contract

First-pass available shape:

```typescript
type ApiContextBudgetSnapshot = {
  status: "available";
  model: string;
  provider: "openai" | "anthropic" | string;
  context_window_tokens: number;
  compaction_enabled: boolean;
  compaction_threshold_ratio: number;
  compaction_threshold_tokens: number;
  effective_budget_tokens: number;
  estimated_input_tokens: number;
  remaining_context_tokens: number;
  percent_of_context_budget: number;
  percent_of_model_window: number;
  basis: "model_agnostic_estimate" | "provider_usage_plus_delta";
  confidence: "low" | "medium" | "high";
  stale: boolean;
  updated_at: string;
  latest_checkpoint_id: string | null;
  compacted_through_message_id: string | null;
  compacted_through_llm_call_id: string | null;
};
```

Unknown/degraded shape:

```typescript
type ApiContextBudgetUnknown = {
  status: "unknown";
  model: string;
  provider: string | null;
  reason: "unknown_model_context_window" | "conversation_unavailable" | "count_failed";
  stale: boolean;
  updated_at: string;
};
```

The API may use a single discriminated union field: `context_budget: ApiContextBudgetSnapshot | ApiContextBudgetUnknown`.

### Counting Rules

The count represents the next provider request input as closely as the service can know:

1. fresh system prompt
2. latest completed checkpoint replacement history, if any
3. post-checkpoint transcript rows
4. post-checkpoint same-provider ledger rows when the loader would replay them
5. provider/tool request envelope where included by the chosen estimate
6. active in-memory loop additions only through a narrow runtime delta if a future phase adds one

The user-facing meter may lag during an active turn. The automatic compaction guardrail inside the agent loop must not lag; it still runs pre-turn and mid-turn using the in-memory conversation that will be sent to the provider.

### Tier 0 Baseline

Tier 0 uses model-agnostic character estimates and fixed overhead. This is the fallback for every model/provider.

### Tier 1 Provider Usage Plus Delta

Tier 1 anchors on latest valid `llm_call.usage`:

```text
estimated_input_tokens =
  latest_llm_call.usage.input_tokens
  + replayable_output_tokens_from_latest_llm_call
  + estimated_delta_after_latest_llm_call
```

If the adapter cannot separate replayable from non-replayable output, it may use total `output_tokens` conservatively and reduce confidence.

Tier 1 is only valid when:

- latest call is after the active checkpoint boundary
- provider/model/reasoning still match the effective thread selection
- request-shape assumptions still match current system prompt/tool schemas
- the latest call has usable input/output token data

System prompts and tool schemas are static enough for the first pass; any future dynamic prompt/tool registry must invalidate Tier 1 anchors when those inputs change.

### API Surface

First pass:

- add `context_budget` to `GET /api/threads/:threadId/agent/state`
- include `context_budget` in the thread detail/bootstrap response if the existing loader path can do it without duplicating work
- do not emit a `context.budget` SSE event

All browser-facing reads must authorize the thread before loading messages, checkpoints, provider ledger rows, or model metadata.

### Web UI

Add a compact context meter near the model/reasoning controls in the workbench composer area.

Expected behavior:

- visual shows percent used against `effective_budget_tokens`
- hover/details show rounded token values like `312k`
- normal/elevated/near-threshold colors are restrained
- unknown/degraded/stale states are understandable but not noisy
- copy says "before auto-compact" only when `compaction_enabled` is true
- no manual compaction action in the first pass

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 0 | [phase-0-current-state-and-contract-lock.md](./phase-0-current-state-and-contract-lock.md) | Urgent | Confirm branch state, field names, and API ownership boundaries before code edits |
| 1 | [phase-1-backend-budget-snapshot.md](./phase-1-backend-budget-snapshot.md) | Urgent | Add Tier 0 checkpoint-aware budget snapshot helper and tests |
| 2 | [phase-2-provider-usage-plus-delta.md](./phase-2-provider-usage-plus-delta.md) | High | Improve estimates with provider usage plus delta, including output-token handling |
| 3 | [phase-3-api-and-agent-state-contract.md](./phase-3-api-and-agent-state-contract.md) | High | Expose `context_budget` through agent state and first-party API types |
| 4 | [phase-4-web-context-meter-ui.md](./phase-4-web-context-meter-ui.md) | High | Render the context meter in the web workbench |
| 5 | [phase-5-validation-docs-and-rollout.md](./phase-5-validation-docs-and-rollout.md) | High | Complete validation, spec updates, and rollout notes |

## Expected Files And Areas

### Service

- `service/src/agent/context-budget.ts`
- `service/src/agent/context-budget-estimator.ts`
- `service/src/agent/context-budget-snapshot.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/agent-service.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/llm/provider-ledger.ts`
- `service/src/llm/provider.ts`
- `service/src/llm/model-catalog.ts`
- `service/src/routes/threads/`

### Web

- `web/src/lib/api-types.ts`
- `web/src/lib/models.ts`
- `web/src/features/threads/`
- `web/src/components/workbench/command-composer.tsx`
- `web/src/components/workbench/`

### Docs / Specs

- `service/src/agent/agent.spec.md`
- `service/src/llm/llm.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `service/src/runtime/runtime.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/features/threads/threads.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `bud.spec.md`

`docs/proto.md` should not need an update unless the implementation adds SSE events despite the current decision.

## Open Questions

- Should Tier 1 use total `output_tokens` for all providers, or should adapters expose a replayable-output estimate when they can distinguish hidden reasoning/non-replayable output?
- Which thread bootstrap response should carry `context_budget`, if any, without introducing duplicate route work?
- Does `/agent/state` already refresh often enough after compaction completion and provider call completion for the meter to feel current?
- How should future local model descriptors represent context window, tokenizer file, and chat template metadata?

## Known Unknowns

- Provider usage semantics can differ for hidden reasoning, encrypted reasoning, and non-replayable output blocks.
- Current persisted usage may lack enough detail to distinguish replayable vs non-replayable output tokens.
- Tool schema and system prompt overhead may not be included in Tier 0 estimates.
- Large multimodal inputs may need provider-specific accounting before text-only workloads do.
- Active-turn durable state can lag the in-memory loop; the first UI should tolerate stale snapshots.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Meter disagrees with auto-compaction trigger | Medium | High | Reuse `resolveContextBudget(...)`; add threshold parity tests |
| Checkpointed threads still look near-full after compaction | Medium | High | Compute from loader reconstruction, not visible transcript rows |
| Tier 1 double-counts or overcounts output tokens | Medium | Medium | Gate on valid anchors, lower confidence when using total output tokens, compare against Tier 0 in tests |
| UI implies false precision | Medium | Medium | Show percent visually, rounded tokens in details, and basis/confidence in tooltip |
| Agent-state refresh is too stale | Medium | Low | Mark snapshots stale during active turns; revisit SSE only if needed |
| Authorization leak through budget endpoint | Low | High | Resolve thread ownership before all budget reads and test non-owner access |

## Rollout Strategy

1. Land backend Tier 0 snapshot helpers and tests without exposing client API fields.
2. Add Tier 1 provider usage plus delta and compare against Tier 0 in tests.
3. Expose `context_budget` on authorized agent state.
4. Add first-party TypeScript types and web UI.
5. Complete manual validation on normal, checkpointed, and near-threshold threads.
6. Defer provider token-count APIs, tokenizer adapters, and manual compaction actions until product need is clear.

## Definition Of Done

- [ ] Backend snapshots use the same threshold math as automatic compaction.
- [ ] Checkpointed reconstruction is counted correctly.
- [ ] Tier 0 works for every known model with a context window.
- [ ] Tier 1 uses input and output token usage when valid.
- [ ] Unknown/degraded snapshots are stable and client-safe.
- [ ] `/agent/state` exposes `context_budget` with ownership enforcement.
- [ ] Web renders the meter near model/reasoning controls.
- [ ] Tests cover normal, checkpointed, unknown, stale, and Tier 1 cases.
- [ ] Relevant spec files and this plan are updated.

## Deferred Follow-Ups

- provider token-count API adapters
- local tokenizer adapters
- local model descriptor metadata
- manual compaction slash command or menu action
- dedicated `context.budget` SSE event
- persisted budget snapshots or analytics
