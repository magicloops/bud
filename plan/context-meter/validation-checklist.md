# Validation Checklist: Conversation Context Budget Meter

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Phase 9 Automated Validation Complete

---

## Automated Backend Validation

- [x] `resolveContextBudget(...)` parity: snapshot threshold matches automatic compaction threshold.
- [x] Known model returns `status: "available"`.
- [x] Unknown model context window returns `status: "unknown"` with `reason: "unknown_model_context_window"`.
- [x] Auto-compaction disabled uses `usable_input_window_tokens` as `effective_budget_tokens` when context policy is known.
- [ ] No-checkpoint thread counts reconstructed model-visible context.
- [ ] Checkpointed thread counts fresh system prompt plus replacement history plus post-checkpoint deltas.
- [ ] Visible transcript rows before checkpoint do not inflate the snapshot.
- [x] Tier 0 returns `basis: "model_agnostic_estimate"`.
- [x] Tier 1 returns `basis: "provider_usage_plus_delta"` when valid usage exists.
- [x] Tier 1 includes output-token usage for replayed assistant output where available.
- [ ] Tier 1 ignores usage anchors before the latest checkpoint boundary.
- [ ] Tier 1 falls back on provider/model/reasoning mismatch.
- [ ] Tier 1 adds post-call delta estimates.
- [ ] Snapshot failure returns `reason: "count_failed"` without exposing prompt contents.

## Usable Context Policy Validation

- [x] Models without usable-context overrides default `usable_context_window_tokens` to `context_window_tokens`.
- [x] Models without output-reserve overrides default `reserved_output_tokens` to `max_output_tokens`.
- [x] GPT-5.5 reports `context_window_tokens: 1050000`.
- [x] GPT-5.5 reports `usable_context_window_tokens: 400000`.
- [x] GPT-5.5 reports `reserved_output_tokens: 128000`.
- [x] GPT-5.5 reports `usable_input_window_tokens: 272000`.
- [x] GPT-5.5 reports `compaction_threshold_tokens: 258400` at the `0.95` clamp.
- [x] `AGENT_AUTO_COMPACTION_RATIO` values above `0.95` clamp to `0.95`.
- [x] Invalid policy where reserved output exceeds usable window returns `Context unknown` or an unknown snapshot reason rather than crashing.
- [x] Normal-turn compaction uses `compaction_threshold_tokens`.
- [x] Compaction summary trimming uses `usable_input_window_tokens`.

## Route And Ownership Validation

- [ ] Owner receives `context_budget` on `/api/threads/:threadId/agent/state`.
- [ ] Unauthenticated request receives `401`.
- [ ] Authenticated non-owner receives `404`.
- [ ] Snapshot response excludes raw prompt text.
- [ ] Snapshot response excludes checkpoint summary and replacement history contents.
- [ ] Snapshot response excludes provider ledger payloads.
- [ ] Existing agent-state fields remain backward compatible.
- [ ] No `context.budget` SSE event is emitted in the first pass.
- [x] `/api/models` exposes `usable_context_window_tokens`, `reserved_output_tokens`, and `usable_input_window_tokens`.

## Automated Frontend Validation

- [x] API types include available and unknown context budget unions.
- [x] Normal state renders percent of effective budget.
- [x] Elevated state renders at the configured UI threshold.
- [x] Near-threshold state renders without blocking message send.
- [x] Unknown state renders `Context unknown` or equivalent.
- [x] Stale state renders a subtle stale/counting indication.
- [x] Disabled auto-compaction copy avoids `before auto-compact`.
- [x] Tooltip/details show rounded token values such as `312k`.
- [x] Tooltip/details show basis and confidence.
- [x] Tooltip/details show hard window, usable window, output reserve, and usable input window.
- [ ] Layout does not overflow in narrow composer widths.

## Manual Service Validation

- [ ] Start a new short thread and confirm the meter reports low usage.
- [ ] Use a long thread near threshold and confirm usage approaches 100%.
- [ ] Trigger automatic compaction and confirm the next snapshot drops after checkpointing.
- [ ] Confirm visible transcript remains unchanged after compaction.
- [ ] Switch to a model with a different context window and confirm the budget recalculates.
- [ ] Temporarily disable auto-compaction and confirm effective budget becomes the usable input window.
- [ ] Force or simulate unknown model context window and confirm degraded UI.
- [ ] Force or simulate invalid local model context policy and confirm `Context unknown`.
- [ ] During an active long tool loop, confirm the UI can be stale while internal compaction still occurs before provider calls.

## Manual Web Validation

- [ ] Meter appears near model/reasoning controls.
- [ ] Compact view shows percent, not exact token count.
- [ ] Hover/details show rounded tokens and estimate basis.
- [ ] Hover/details show usable context cap and output reserve.
- [ ] Copy says `before auto-compact` only when compaction is enabled.
- [ ] No manual compaction action appears.
- [ ] Thread open, message send, and final refresh update the meter.
- [ ] Mobile-ish/narrow viewport remains readable.

## Build And Docs Validation

- [x] Focused service tests pass.
- [x] Focused web tests or build pass.
- [x] `service/src/agent/agent.spec.md` updated.
- [x] `service/src/llm/llm.spec.md` updated if Tier 1 usage behavior changes LLM docs.
- [x] `service/src/routes/routes.spec.md` updated.
- [x] `service/src/routes/threads/threads.spec.md` updated.
- [x] `service/src/runtime/runtime.spec.md` updated if agent-state shape changes there.
- [x] `web/src/lib/lib.spec.md` updated.
- [x] `web/src/features/threads/threads.spec.md` updated.
- [x] `web/src/components/workbench/workbench.spec.md` updated.
- [x] `bud.spec.md` updated.
- [x] `docs/proto.md` remains unchanged unless an SSE event is added.

Phase 9 automated validation was run on 2026-05-24. Remaining unchecked items
are either broader original context-meter coverage that was not re-run in this
phase or manual/browser scenarios that still need explicit product validation.
