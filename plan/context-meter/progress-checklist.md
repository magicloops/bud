# Progress Checklist: Conversation Context Budget Meter

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Phase 11-14 Implemented; Phase 15 Tool-Schema Overhead In Progress; Phase 10 Browser Layout Validation Blocked

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
- [ ] Confirm no dedicated `agent.context_budget` SSE event is introduced.
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

## Phase 11: Authoritative Budget Contract And Tests

- [x] Clarify `estimated_input_tokens` as the backend authoritative input estimate.
- [x] Move provider usage plus delta out of primary meter basis.
- [x] Add provenance fields to service/web budget types.
- [x] Add optional `provider_usage_estimate` diagnostics.
- [x] Add regression test for provider usage exceeding threshold while backend trigger estimate is below threshold.
- [x] Update web presentation tests for default diagnostic hiding.
- [x] Update affected specs.

## Phase 12: Shared Budget State Helper

- [x] Add shared budget-state helper for `CanonicalMessage[]` inputs.
- [x] Use helper from `AgentService.compactConversationIfNeeded(...)`.
- [x] Use helper from durable `/agent/state.context_budget` reconstruction.
- [x] Preserve provider usage plus delta as optional diagnostics.
- [x] Align compaction decision logs with snapshot fields.
- [x] Add focused service tests proving trigger estimate and snapshot primary estimate match.

## Phase 13: Runtime Active Budget State

- [x] Add `context_budget` to `AgentRuntimeSnapshot`.
- [x] Add runtime mutators for setting/clearing active context budget.
- [x] Store latest budget decision during pre-turn and mid-turn compaction checks.
- [x] Make `/agent/state` prefer matching active runtime budget during active turns.
- [x] Ensure final/cancel paths return an up-to-date budget for the next user turn.
- [x] Add runtime and agent-service tests.

## Phase 14: Web Refresh And Compaction Payloads

- [x] Add optional `context_budget` to `agent.compaction_done`.
- [x] Update first-party API/SSE types.
- [x] Update web stream handling to apply post-compaction budget snapshots.
- [x] Keep `/agent/state` refresh fallback after compaction/final/resync/cancel.
- [x] Keep provider usage diagnostics out of the product-facing context tooltip.
- [x] Remove the temporary `VITE_CONTEXT_BUDGET_DEBUG` front-end flag.
- [x] Update docs/proto if SSE event shape docs require the additive field.

## Phase 15: Calibration And Trigger Estimator Follow-Up

- [ ] Add safe trigger-vs-provider diagnostic logging.
- [x] Include normal agent tool-schema overhead in backend trigger estimates and `/agent/state.context_budget`.
- [x] Expose message-vs-tool-schema token split in context-budget snapshots and tooltip details.
- [ ] Measure remaining fixed request overhead beyond tool schemas.
- [ ] Decide whether additional estimator overhead adjustment is justified.
- [x] Add tests for tool-schema estimator adjustment.
- [ ] Keep provider usage diagnostic-only unless a future design changes trigger basis.

Phase 15a includes the current normal agent tool schemas in the primary trigger
estimate. Broader calibration remains open for provider-specific request
envelope overhead.

## Deferred Follow-Ups

- [ ] Provider token-count API adapters.
- [ ] Local tokenizer adapters.
- [ ] Local model context-window/tokenizer metadata.
- [ ] Per-model compaction ratio overrides.
- [ ] Request-kind-specific output reserve fields.
- [ ] Manual compaction slash command or menu item.
- [ ] Dedicated `agent.context_budget` SSE event if `/agent/state` refresh and post-compaction snapshots are insufficient.
- [ ] Persisted budget snapshots or usage analytics.
