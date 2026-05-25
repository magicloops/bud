# Progress Checklist: Conversation Context Budget Meter

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Phase 10 Implemented; Browser Layout Validation Blocked

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

## Phase 6: Usable Context Policy Resolver

- [x] Add `usableContextWindowTokens` and `reservedOutputTokens` catalog fields.
- [x] Add a shared context policy resolver.
- [x] Default usable context window to `contextWindowTokens`.
- [x] Default output reserve to `maxOutputTokens`.
- [x] Raise the automatic-compaction ratio clamp to `0.95`.
- [x] Configure GPT-5.5 with a 400k usable context cap and 128k output reserve.
- [x] Return a safe unknown/invalid policy result for missing or invalid usable input.
- [x] Add resolver tests for defaults, overrides, GPT-5.5, and invalid policy.

## Phase 7: Agent Compaction Budget Semantics

- [x] Expand internal `ContextBudget` with hard, usable, reserve, input, and threshold fields.
- [x] Update automatic compaction checks to use usable input threshold.
- [x] Update disabled-compaction effective budget to use usable input window.
- [x] Update compaction summary trimming to use `usableInputWindowTokens`.
- [x] Preserve provider-call behavior when budget reporting is unknown.
- [x] Add GPT-5.5 250k/260k threshold behavior tests.

## Phase 8: API Models And Web Policy Fields

- [x] Add `usable_context_window_tokens` to `/api/models`.
- [x] Add `reserved_output_tokens` to `/api/models`.
- [x] Add `usable_input_window_tokens` to `/api/models`.
- [x] Add usable-context fields to `context_budget` snapshots.
- [x] Update web API/model types.
- [x] Update meter details to show hard window, usable window, output reserve, and threshold.
- [x] Render `Context unknown` for missing or invalid model policy.

## Phase 9: Usable Context Validation Docs And Rollout

- [x] Run focused service validation for context policy and compaction semantics.
- [x] Run focused web validation for new fields and meter details.
- [ ] Manually validate GPT-5.5 budget behavior.
- [ ] Manually validate invalid local-model policy fallback.
- [x] Update affected specs.
- [x] Document rollout and deferred follow-ups.

Phase 9 automated validation completed on 2026-05-24. Product/manual validation
has covered most first-pass behavior; the remaining manual-only checks stay
tracked in [validation-checklist.md](./validation-checklist.md).

## Phase 10: Radial Send Button Context Meter

- [x] Scope circular send-button context meter behavior.
- [x] Replace the dedicated visible context meter with the send-button ring.
- [x] Move the context tooltip trigger to the send control.
- [x] Preserve unknown, stale, near-threshold, over-threshold, and disabled states.
- [x] Update web tests for radial/send-button presentation.
- [x] Update workbench specs after implementation.
- [x] Validate focused web test and web build.
- [ ] Validate browser layout.

Browser layout validation is blocked in this session because the in-app browser
rejected the local dev URL. Use a permitted preview URL for the remaining manual
ring/tooltip check.

## Deferred Follow-Ups

- [ ] Provider token-count API adapters.
- [ ] Local tokenizer adapters.
- [ ] Local model context-window/tokenizer metadata.
- [ ] Per-model compaction ratio overrides.
- [ ] Request-kind-specific output reserve fields.
- [ ] Manual compaction slash command or menu item.
- [ ] Dedicated `context.budget` SSE event if agent-state refresh is insufficient.
- [ ] Persisted budget snapshots or usage analytics.
