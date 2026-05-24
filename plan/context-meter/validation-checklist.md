# Validation Checklist: Conversation Context Budget Meter

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Automated Backend Validation

- [ ] `resolveContextBudget(...)` parity: snapshot threshold matches automatic compaction threshold.
- [ ] Known model returns `status: "available"`.
- [ ] Unknown model context window returns `status: "unknown"` with `reason: "unknown_model_context_window"`.
- [ ] Auto-compaction disabled uses full `context_window_tokens` as `effective_budget_tokens`.
- [ ] No-checkpoint thread counts reconstructed model-visible context.
- [ ] Checkpointed thread counts fresh system prompt plus replacement history plus post-checkpoint deltas.
- [ ] Visible transcript rows before checkpoint do not inflate the snapshot.
- [ ] Tier 0 returns `basis: "model_agnostic_estimate"`.
- [ ] Tier 1 returns `basis: "provider_usage_plus_delta"` when valid usage exists.
- [ ] Tier 1 includes output-token usage for replayed assistant output where available.
- [ ] Tier 1 ignores usage anchors before the latest checkpoint boundary.
- [ ] Tier 1 falls back on provider/model/reasoning mismatch.
- [ ] Tier 1 adds post-call delta estimates.
- [ ] Snapshot failure returns `reason: "count_failed"` without exposing prompt contents.

## Route And Ownership Validation

- [ ] Owner receives `context_budget` on `/api/threads/:threadId/agent/state`.
- [ ] Unauthenticated request receives `401`.
- [ ] Authenticated non-owner receives `404`.
- [ ] Snapshot response excludes raw prompt text.
- [ ] Snapshot response excludes checkpoint summary and replacement history contents.
- [ ] Snapshot response excludes provider ledger payloads.
- [ ] Existing agent-state fields remain backward compatible.
- [ ] No `context.budget` SSE event is emitted in the first pass.

## Automated Frontend Validation

- [ ] API types include available and unknown context budget unions.
- [ ] Normal state renders percent of effective budget.
- [ ] Elevated state renders at the configured UI threshold.
- [ ] Near-threshold state renders without blocking message send.
- [ ] Unknown state renders `Context unknown` or equivalent.
- [ ] Stale state renders a subtle stale/counting indication.
- [ ] Disabled auto-compaction copy avoids `before auto-compact`.
- [ ] Tooltip/details show rounded token values such as `312k`.
- [ ] Tooltip/details show basis and confidence.
- [ ] Layout does not overflow in narrow composer widths.

## Manual Service Validation

- [ ] Start a new short thread and confirm the meter reports low usage.
- [ ] Use a long thread near threshold and confirm usage approaches 100%.
- [ ] Trigger automatic compaction and confirm the next snapshot drops after checkpointing.
- [ ] Confirm visible transcript remains unchanged after compaction.
- [ ] Switch to a model with a different context window and confirm the budget recalculates.
- [ ] Temporarily disable auto-compaction and confirm effective budget becomes the full model window.
- [ ] Force or simulate unknown model context window and confirm degraded UI.
- [ ] During an active long tool loop, confirm the UI can be stale while internal compaction still occurs before provider calls.

## Manual Web Validation

- [ ] Meter appears near model/reasoning controls.
- [ ] Compact view shows percent, not exact token count.
- [ ] Hover/details show rounded tokens and estimate basis.
- [ ] Copy says `before auto-compact` only when compaction is enabled.
- [ ] No manual compaction action appears.
- [ ] Thread open, message send, and final refresh update the meter.
- [ ] Mobile-ish/narrow viewport remains readable.

## Build And Docs Validation

- [ ] Focused service tests pass.
- [ ] Focused web tests or build pass.
- [ ] `service/src/agent/agent.spec.md` updated.
- [ ] `service/src/llm/llm.spec.md` updated if Tier 1 usage behavior changes LLM docs.
- [ ] `service/src/routes/routes.spec.md` updated.
- [ ] `service/src/routes/threads/threads.spec.md` updated.
- [ ] `service/src/runtime/runtime.spec.md` updated if agent-state shape changes there.
- [ ] `web/src/lib/lib.spec.md` updated.
- [ ] `web/src/features/threads/threads.spec.md` updated.
- [ ] `web/src/components/workbench/workbench.spec.md` updated.
- [ ] `bud.spec.md` updated.
- [ ] `docs/proto.md` remains unchanged unless an SSE event is added.
