# Implementation Spec: Conversation Context Budget Meter

**Status**: Phases 0-14 implemented/validated in part; Phase 15 tool-schema overhead in progress
**Created**: 2026-05-24
**Design Doc**: [../../design/conversation-context-budget-meter.md](../../design/conversation-context-budget-meter.md)
**Usable Context Design**: [../../design/usable-context-window-and-output-reserve.md](../../design/usable-context-window-and-output-reserve.md)
**Authoritative Budget Design**: [../../design/authoritative-context-budget-state.md](../../design/authoritative-context-budget-state.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 0**: [phase-0-current-state-and-contract-lock.md](./phase-0-current-state-and-contract-lock.md)
**Phase 1**: [phase-1-backend-budget-snapshot.md](./phase-1-backend-budget-snapshot.md)
**Phase 2**: [phase-2-provider-usage-plus-delta.md](./phase-2-provider-usage-plus-delta.md)
**Phase 3**: [phase-3-api-and-agent-state-contract.md](./phase-3-api-and-agent-state-contract.md)
**Phase 4**: [phase-4-web-context-meter-ui.md](./phase-4-web-context-meter-ui.md)
**Phase 5**: [phase-5-validation-docs-and-rollout.md](./phase-5-validation-docs-and-rollout.md)
**Phase 6**: [phase-6-usable-context-policy-resolver.md](./phase-6-usable-context-policy-resolver.md)
**Phase 7**: [phase-7-agent-compaction-budget-semantics.md](./phase-7-agent-compaction-budget-semantics.md)
**Phase 8**: [phase-8-api-models-and-web-policy-fields.md](./phase-8-api-models-and-web-policy-fields.md)
**Phase 9**: [phase-9-usable-context-validation-docs-and-rollout.md](./phase-9-usable-context-validation-docs-and-rollout.md)
**Phase 10**: [phase-10-radial-send-button-context.md](./phase-10-radial-send-button-context.md)
**Phase 11**: [phase-11-authoritative-budget-contract-and-tests.md](./phase-11-authoritative-budget-contract-and-tests.md)
**Phase 12**: [phase-12-shared-budget-state-helper.md](./phase-12-shared-budget-state-helper.md)
**Phase 13**: [phase-13-runtime-active-budget-state.md](./phase-13-runtime-active-budget-state.md)
**Phase 14**: [phase-14-web-refresh-and-compaction-payloads.md](./phase-14-web-refresh-and-compaction-payloads.md)
**Phase 15**: [phase-15-calibration-and-trigger-estimator-follow-up.md](./phase-15-calibration-and-trigger-estimator-follow-up.md)

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
- make the primary snapshot estimate match the backend compaction-decision
  estimate
- expose the snapshot through authenticated thread/agent state APIs
- show a compact meter in the web workbench
- use a model-agnostic estimate everywhere as the baseline
- expose provider usage plus delta as diagnostics instead of primary meter math
- avoid adding a noisy new SSE event family in the first pass
- avoid coupling the UI to raw in-memory agent-loop internals

## Fixed Decisions

These decisions are fixed for the initial implementation:

- The primary UI shows compaction-budget usage, not raw model-window usage.
- The primary UI estimate must match the backend compaction-decision estimate.
- The initial meter shipped against the existing `AGENT_AUTO_COMPACTION_RATIO`
  cap, then follow-on usable-context work raises the cap to `0.95`.
- Clients must read the effective threshold from the service; no client
  hardcoding of ratio values.
- If auto-compaction is disabled but context policy is known, the effective
  meter limit is the usable input window, not the hard model context window.
- No dedicated per-sub-turn `agent.context_budget` SSE event ships in the first pass.
- Active budget state lives in `AgentRuntimeStateManager` so `/agent/state` can
  report the latest backend decision after refresh, finalization, or cancel.
- Tier 0 model-agnostic counting ships first.
- Provider response usage, including output tokens, is diagnostic-only unless
  the backend trigger intentionally adopts it later.
- Normal agent-turn tool schemas are included in the backend trigger estimate
  and `context_budget.estimated_input_tokens`; compaction-summary calls do not
  add this normal-agent tool-schema overhead because they use no tools.
- Provider usage diagnostics are backend/API diagnostics only in this pass; the
  product context tooltip does not render them.
- `agent.compaction_done` may carry an additive post-compaction
  `context_budget` snapshot.
- Output reserve defaults to `maxOutputTokens`, with explicit per-model overrides.
- `/api/models` exposes `usable_input_window_tokens`.
- Missing or invalid local-model context policy renders `Context unknown`.
- Provider token-count APIs are deferred.
- Local tokenizer adapters are deferred.
- Manual compaction UI or `/compact` handling is deferred.
- Visual UI uses percentages; hover/details may show rounded token values such as `312k`.

## Success Criteria

- [ ] A thread with no checkpoint reports context usage from the reconstructed model-visible request, not from client-side transcript counting.
- [ ] A checkpointed thread reports usage from fresh system prompt plus checkpoint replacement history plus post-checkpoint deltas.
- [ ] The reported threshold matches `resolveContextBudget(...)` and automatic compaction behavior.
- [ ] The primary estimate shown in the web matches the backend compaction
      decision estimate.
- [ ] A model with unknown context window returns an unknown/degraded snapshot rather than crashing.
- [ ] Provider usage diagnostics include output-token usage where available
      without driving the primary meter.
- [ ] Provider usage diagnostics invalidate on provider, model, reasoning,
      checkpoint, or request-shape changes.
- [ ] `/agent/state` returns `context_budget` only after ownership is resolved.
- [ ] `/agent/state` returns the latest active budget decision during an active
      turn when available.
- [ ] Web renders normal, elevated, near-threshold, unknown, stale, and degraded states.
- [ ] `agent.compaction_done.context_budget` updates the meter immediately when
      present, with `/agent/state` as fallback.

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
- `service/src/agent/context-budget-state.ts` owns authoritative budget state construction from a `CanonicalMessage[]`
- `service/src/agent/context-budget-snapshot.ts` or a route-local service helper owns authorization-safe snapshot orchestration and optional provider diagnostics

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
  usable_context_window_tokens: number;
  reserved_output_tokens: number;
  usable_input_window_tokens: number;
  effective_budget_tokens: number;
  message_estimated_tokens: number;
  tool_schema_tokens: number;
  estimated_input_tokens: number;
  remaining_context_tokens: number;
  percent_of_context_budget: number;
  percent_of_model_window: number;
  basis: "model_agnostic_estimate" | "provider_usage_trigger" | "provider_token_count";
  confidence: "low" | "medium" | "high";
  source: "durable_reconstruction" | "active_agent_decision" | "compaction_event" | "unknown";
  phase: "idle" | "pre_turn" | "mid_turn" | "standalone_turn" | null;
  reason: "context_limit" | "context_error_retry" | "model_downshift" | "user_requested" | null;
  turn_id: string | null;
  checked_at: string | null;
  stale: boolean;
  updated_at: string;
  provider_usage_estimate?: {
    estimated_input_tokens: number;
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens?: number;
    delta_tokens: number;
    llm_call_id: string;
    confidence: "medium" | "high";
  } | null;
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
  reason: "unknown_model_context_window" | "invalid_context_policy" | "conversation_unavailable" | "count_failed";
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
5. normal agent tool schemas for ordinary agent-turn provider requests
6. provider/tool request envelope where included by the chosen estimate
7. active in-memory loop additions only through a narrow runtime delta if a future phase adds one

The user-facing meter may lag during an active turn. The automatic compaction guardrail inside the agent loop must not lag; it still runs pre-turn and mid-turn using the in-memory conversation that will be sent to the provider.

### Tier 0 Baseline

Tier 0 uses model-agnostic character estimates and fixed overhead. This is the
fallback for every model/provider. For ordinary agent turns, Tier 0 includes a
serialized estimate of the current normal-agent tool schemas so trigger
decisions and `/agent/state.context_budget` account for tool definitions that
will be sent to providers.

### Provider Usage Diagnostics

Provider usage diagnostics anchor on latest valid `llm_call.usage`:

```text
provider_usage_estimate.estimated_input_tokens =
  latest_llm_call.usage.input_tokens
  + replayable_output_tokens_from_latest_llm_call
  + estimated_delta_after_latest_llm_call
```

If the adapter cannot separate replayable from non-replayable output, it may use total `output_tokens` conservatively and reduce confidence.

Provider usage diagnostics are only valid when:

- latest call is after the active checkpoint boundary
- provider/model/reasoning still match the effective thread selection
- request-shape assumptions still match current system prompt/tool schemas
- the latest call has usable input/output token data

System prompts and tool schemas are static enough for the first pass; any future dynamic prompt/tool registry must invalidate provider usage diagnostics when those inputs change.

Provider usage diagnostics do not drive `percent_of_context_budget` unless a
future backend trigger design intentionally adopts provider usage as the
compaction decision basis.

### API Surface

First pass:

- add `context_budget` to `GET /api/threads/:threadId/agent/state`
- include `context_budget` in the thread detail/bootstrap response if the existing loader path can do it without duplicating work
- do not emit a standalone `agent.context_budget` SSE event
- include optional `context_budget` on `agent.compaction_done` for immediate
  post-checkpoint UI updates

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
| 6 | [phase-6-usable-context-policy-resolver.md](./phase-6-usable-context-policy-resolver.md) | High | Add model usable-context/output-reserve policy resolver and GPT-5.5 budget |
| 7 | [phase-7-agent-compaction-budget-semantics.md](./phase-7-agent-compaction-budget-semantics.md) | High | Move agent compaction and summary trimming to usable-input semantics |
| 8 | [phase-8-api-models-and-web-policy-fields.md](./phase-8-api-models-and-web-policy-fields.md) | High | Expose usable-context policy fields through APIs and meter details |
| 9 | [phase-9-usable-context-validation-docs-and-rollout.md](./phase-9-usable-context-validation-docs-and-rollout.md) | High | Validate usable-context rollout and update specs |
| 10 | [phase-10-radial-send-button-context.md](./phase-10-radial-send-button-context.md) | High | Move the context meter into the circular send button |
| 11 | [phase-11-authoritative-budget-contract-and-tests.md](./phase-11-authoritative-budget-contract-and-tests.md) | Urgent | Lock the primary budget contract to backend compaction-decision estimates |
| 12 | [phase-12-shared-budget-state-helper.md](./phase-12-shared-budget-state-helper.md) | Urgent | Share one budget-state builder between agent decisions and snapshots |
| 13 | [phase-13-runtime-active-budget-state.md](./phase-13-runtime-active-budget-state.md) | High | Store latest active budget state in `AgentRuntimeStateManager` |
| 14 | [phase-14-web-refresh-and-compaction-payloads.md](./phase-14-web-refresh-and-compaction-payloads.md) | High | Apply post-compaction budget snapshots and keep provider diagnostics out of product UI |
| 15 | [phase-15-calibration-and-trigger-estimator-follow-up.md](./phase-15-calibration-and-trigger-estimator-follow-up.md) | Medium | Calibrate trigger estimator vs provider diagnostics |

## Expected Files And Areas

### Service

- `service/src/agent/context-budget.ts`
- `service/src/agent/context-budget-snapshot.ts`
- `service/src/agent/context-budget-state.ts`
- `service/src/agent/tool-definitions.ts`
- `service/src/agent/conversation-loader.ts`
- `service/src/agent/agent-service.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/llm/provider-ledger.ts`
- `service/src/llm/provider.ts`
- `service/src/llm/model-catalog.ts`
- `service/src/routes/models.ts`
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

`docs/proto.md` should be updated if the documented `agent.compaction_done`
shape gains the additive `context_budget` field.

## Open Questions

- Which thread bootstrap response should carry `context_budget`, if any, without introducing duplicate route work?
- How should future local model descriptors represent context window, tokenizer file, and chat template metadata?
- What minimum local model metadata should be required before showing a
  percentage meter instead of `Context unknown`?
- Should the trigger estimator add further fixed request-envelope overhead after
  tool schemas?

## Known Unknowns

- Provider usage semantics can differ for hidden reasoning, encrypted reasoning, and non-replayable output blocks.
- Current persisted usage may lack enough detail to distinguish replayable vs non-replayable output tokens.
- Provider request framing beyond normal agent tool schemas may still be
  undercounted in Tier 0 estimates.
- Large multimodal inputs may need provider-specific accounting before text-only workloads do.
- Active-turn durable state can lag the in-memory loop; the first UI should tolerate stale snapshots.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Meter disagrees with auto-compaction trigger | Medium | High | Use a shared authoritative budget-state helper and active runtime budget state |
| Checkpointed threads still look near-full after compaction | Medium | High | Compute from loader reconstruction, not visible transcript rows |
| Provider usage diagnostics double-count or overcount output tokens | Medium | Low | Keep diagnostics out of primary meter math; gate debug display |
| UI implies false precision | Medium | Medium | Show percent visually, rounded tokens in details, and basis/confidence in tooltip |
| Agent-state refresh is too stale | Medium | Low | Store latest active budget in runtime state; revisit standalone budget SSE only if needed |
| Authorization leak through budget endpoint | Low | High | Resolve thread ownership before all budget reads and test non-owner access |

## Rollout Strategy

1. Land backend Tier 0 snapshot helpers and tests without exposing client API fields.
2. Add provider usage plus delta diagnostics and compare against the trigger estimate in tests.
3. Expose `context_budget` on authorized agent state.
4. Add first-party TypeScript types and web UI.
5. Complete manual validation on normal, checkpointed, and near-threshold threads.
6. Defer provider token-count APIs, tokenizer adapters, and manual compaction actions until product need is clear.

## Definition Of Done

- [ ] Backend snapshots use the same threshold math as automatic compaction.
- [ ] Backend budget math uses usable input windows rather than hard model windows.
- [ ] Backend trigger estimates include normal agent tool-schema overhead for
      ordinary agent turns.
- [ ] GPT-5.5 derives a 258,400 token compaction threshold from a 400k usable
      cap, 128k output reserve, and 0.95 ratio.
- [ ] Checkpointed reconstruction is counted correctly.
- [ ] Tier 0 works for every known model with a context window.
- [ ] Provider usage diagnostics include input and output token usage when valid.
- [ ] Unknown/degraded snapshots are stable and client-safe.
- [ ] `/agent/state` exposes `context_budget` with ownership enforcement.
- [ ] Active runtime `/agent/state` budget matches the latest backend
      compaction decision.
- [ ] `/api/models` exposes usable context policy fields.
- [ ] Web renders the meter near model/reasoning controls.
- [ ] Tests cover normal, checkpointed, unknown, stale, active-runtime, and provider-diagnostic cases.
- [ ] Relevant spec files and this plan are updated.

## Deferred Follow-Ups

- provider token-count API adapters
- local tokenizer adapters
- local model descriptor metadata
- manual compaction slash command or menu action
- dedicated `agent.context_budget` SSE event
- persisted budget snapshots or analytics
