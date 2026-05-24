# Progress Checklist: Conversation Context Budget Meter

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Phase 0: Current State And Contract Lock

- [ ] Reconfirm current context-budget, loader, provider-ledger, model-catalog, and runtime-state seams.
- [ ] Lock first-pass snapshot field names.
- [ ] Decide whether thread bootstrap includes `context_budget`.
- [ ] Confirm active-turn stale behavior and no raw in-memory conversation exposure.
- [ ] Identify fixtures for no-checkpoint, checkpointed, Tier 1, unknown-window, and disabled-compaction cases.

## Phase 1: Backend Budget Snapshot

- [ ] Add backend snapshot and estimator types.
- [ ] Reuse automatic compaction budget math.
- [ ] Compute `effective_budget_tokens`, `remaining_context_tokens`, and percentages.
- [ ] Load checkpoint-aware model-visible context through the conversation loader.
- [ ] Add Tier 0 model-agnostic snapshot path.
- [ ] Mark snapshots stale during active turns when appropriate.
- [ ] Add focused Tier 0/backend snapshot tests.

## Phase 2: Provider Usage Plus Delta

- [ ] Locate latest valid `llm_call.usage` anchor after checkpoint boundary.
- [ ] Validate provider/model/reasoning/request-shape matches.
- [ ] Include output-token usage for replayed assistant output where available.
- [ ] Estimate deltas after the latest call.
- [ ] Fall back to Tier 0 on invalid or missing usage.
- [ ] Add Tier 1 tests for output tokens, invalidation, and deltas.

## Phase 3: API And Agent State Contract

- [ ] Add `context_budget` to `/api/threads/:threadId/agent/state`.
- [ ] Add bootstrap `context_budget` if selected in Phase 0.
- [ ] Update first-party web API types.
- [ ] Add owner/non-owner route tests.
- [ ] Confirm no dedicated `context.budget` SSE event is introduced.
- [ ] Update route/runtime/lib specs.

## Phase 4: Web Context Meter UI

- [ ] Add percent and rounded-token formatting helpers.
- [ ] Add context meter component.
- [ ] Add tooltip/popover details.
- [ ] Place meter near workbench model/reasoning controls.
- [ ] Handle normal/elevated/near-threshold/unknown/degraded/stale states.
- [ ] Verify refresh after thread open, message send, and final/refresh state.
- [ ] Add component or integration tests where practical.

## Phase 5: Validation Docs And Rollout

- [ ] Run focused service tests.
- [ ] Run focused web tests or build.
- [ ] Complete manual validation checklist.
- [ ] Update all affected specs.
- [ ] Document rollout and fallback notes.
- [ ] Keep deferred follow-ups listed.

## Deferred Follow-Ups

- [ ] Provider token-count API adapters.
- [ ] Local tokenizer adapters.
- [ ] Local model context-window/tokenizer metadata.
- [ ] Manual compaction slash command or menu item.
- [ ] Dedicated `context.budget` SSE event if agent-state refresh is insufficient.
- [ ] Persisted budget snapshots or usage analytics.
