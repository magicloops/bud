# Plan: Provider-anchored context accounting

Status: implemented; automated validation passed and context work accepted by the user. Dedicated restart/reconstruction validation remains a follow-up.

## Context

Use provider-reported input usage when available, estimating only content added since that request. Keep one accounting rule for the context meter and automatic compaction.

Related sources:
- [Agent spec](../service/src/agent/agent.spec.md)
- [LLM spec](../service/src/llm/llm.spec.md)
- [Context meter plan](context-meter/implementation-spec.md)
- [Context breakdown plan](context-popover-breakdown.md)
- [Browser budget comparison](../debug/browser-observation-budget-32k.md)

Our recent matched request comparisons show why this matters:

| Request | Current estimate | Provider input tokens |
| --- | ---: | ---: |
| Initial request, both runs | 16,367 | 12,542 |
| Last request, 8 KiB run | 36,199 | 44,787 |
| Last request, 32 KiB run | 47,138 | 61,105 |

Threads: `2c9e1062-d6a7-4d49-95a7-be3b5738afc8` and `b8c65595-6b7d-40c1-be6f-bbb60beec897`. These are individual request counts, not cumulative billing totals. The estimator changes from overcounting to undercounting as browsing content accumulates; one global multiplier would not solve that.

### Prior implementation

- `context-budget.ts` estimates canonical messages and tool schemas using character counts and fixed overheads.
- `context-budget-state.ts` supplies the primary total and compaction decision from that estimate.
- `context-budget-snapshot.ts` separately reconstructs a provider diagnostic using the latest completed call's input/output usage and timestamp-selected message deltas. It does not drive the primary total.
- `provider-ledger.ts` already stores completed call usage, provider/model/request mode, reconstruction metadata, and output items. It does not currently record a verified request-prefix anchor.
- The web breakdown assumes category estimates sum to the primary total. That assumption must change when the total is anchored to measured usage.

## Objective

For the same reconstructed request, the meter and compaction must use the same total and provenance. Provider measurements should correct accumulated estimation drift without adding another token-counting subsystem.

Acceptance criteria:
- A compatible completed request supplies the measured baseline; only subsequent request content is estimated.
- Missing or incompatible usage falls back safely to the existing estimator.
- Active execution and durable reconstruction use the same resolver.
- Restart, compaction, model changes, and concurrent message arrival cannot attach usage to the wrong request.
- UI distinguishes a measured baseline plus estimated additions from a fully measured current request.

## Design

### 1. One resolver, two accounting paths

```text
compatible anchor:
  current input estimate = provider input tokens + estimated appended request content

otherwise:
  current input estimate = existing complete-request estimate
```

Keep this as a pure helper adjacent to the existing budget code. Return the chosen total, basis, anchor call ID, estimated additions, and a bounded fallback reason. Both decision and snapshot builders consume it; neither implements its own delta algorithm.

Provider usage describes a past request. Do not simply display its input count as the current context, and do not add raw output usage: generated reasoning/output tokens are not necessarily the content replayed in the next request. Estimate the actual appended model-facing blocks once, including assistant text, tool calls, tool results, and new user messages. Tool schemas and prompt overhead already covered by the anchor are not added again.

Preserve current output reserves, thresholds, and context-overflow recovery. This changes accounting, not compaction policy. Remove the misleading suggestion that the existing safety margin necessarily absorbs estimator error.

### 2. Capture a small baseline at the request boundary

Freeze anchor metadata immediately before sending a normal agent request. Associate it with that request's existing call ID, and make it usable only after completed, valid provider usage arrives.

Record the request's compatibility identity and prefix boundary: provider, effective model, reasoning configuration, request mode, checkpoint, actual prompt/tool configuration, and a digest/count of the ordered input prefix. Include provider-native replay content that affects the request; omit volatile product-only metadata. Reuse the existing request assembly and ledger rather than building a second conversation serializer.

Validate that the current input starts with that same prefix. Comparing whole-request hashes would reject every legitimate append; timestamps alone cannot prove prefix compatibility. If reconstruction merges blocks or otherwise changes the prefix, fall back instead of implementing an alignment engine.

Persist only this small versioned record in existing call JSON metadata, alongside existing usage. No new table or copied request archive. Existing calls without baseline metadata use the fallback; no historical backfill. Verify the exact metadata location during implementation and document it in the LLM spec.

Select the latest relevant completed agent call, not a summarization/title call. If it cannot supply a usable anchor, fall back rather than searching and calibrating many historical calls. An in-flight call does not replace the previous completed anchor. Pair usage with its captured request, never with whichever conversation state exists when the response finishes.

### 3. Share request preparation and provider normalization

Active and durable paths must use equivalent reconstructed content and the resolved tool catalog. Eliminate the durable path's static-tool-schema shortcut where it differs from actual request construction. Do not call providers or execute tools to render the meter.

Audit adapter usage normalization for OpenAI, Anthropic, and local/compatible providers. Define total input context consistently, including cached input exactly once; cache discounts are billing details, not context removal. Test the adapters' actual response shapes before deciding whether cache fields need addition or are already included. Keep this normalization separate from billing totals.

Missing, nonfinite, negative, or semantically unsupported usage does not become zero. Opaque reasoning and image additions remain estimates; neither encrypted payload length nor base64 length is an actual token count. This phase does not build a new multimodal estimator. Record that limitation and avoid labeling a mixed total as exact.

### 4. Keep the UI honest

Use the shared total for utilization, remaining capacity, and compaction. Keep anchored accounting provenance in diagnostics. The simplified popover omits the anchored basis label and model name; its estimated composition is always visible. Reserve a measured-only label for an unchanged compatible input with no estimated additions.

Keep category counts as estimated composition. Their denominator is their own sum, not the provider-anchored total. Explicitly label this section as estimated; do not proportionally scale categories or attribute the discrepancy to tool output. Check the segmented bar so it does not imply those approximate shares are measured token attribution.

Prefer deriving the composition denominator from the existing breakdown entries over adding another redundant API total. Update web presentation/tests and audit mobile consumers before changing primary-total semantics. Reuse existing provenance fields where their meaning fits; any necessary additive field must have a clear fallback for older clients. Remove the independent provider diagnostic calculation; retain last-request usage only as optional diagnostic information from the same anchor.

## Edge cases

| Case | Behavior |
| --- | --- |
| First request or old ledger row | Full heuristic estimate |
| Appended text/tools/user messages | Measured baseline plus estimated suffix |
| Prefix edited, reordered, deleted, or replayed differently | Fall back |
| Prompt, tools, model, provider, reasoning mode, or request mode changes | Invalidate incompatible anchor |
| Compaction replaces history | Invalidate; anchor again after the next completed normal request |
| Failure/cancellation/partial streaming usage | Do not publish a new completed anchor |
| Restart | Load existing baseline and revalidate against reconstructed request |
| New messages arrive during a provider call | Keep the frozen baseline; count new request content as additions |
| No known model context window | Preserve unknown-budget behavior |
| Summary/title usage | Never anchor the main conversation to it |

## Complexity to remove and explicit won't-dos

Remove the separate timestamp-based provider delta reconstruction and duplicate active/durable accounting. Remove assumptions that raw output tokens equal replayed input, that a fixed margin bounds estimation error, and that estimated categories must equal the measured primary total.

We will not add:
- Provider token-count requests, tokenizer packages, per-model correction factors, or learned calibration.
- A second context ledger, full-request storage, background reconciliation, or migration/backfill jobs.
- A general prefix-diff engine or custom handling to rescue every incompatible anchor.
- New browser observation limits, pagination changes, or compaction threshold tuning.
- Per-token streaming meter updates or noisy content-level diagnostics.

Use one baseline, one compatibility check, one estimator fallback. If an ordinary workflow repeatedly invalidates the baseline, investigate that specific request transformation before adding more accounting machinery.

## Implementation sequence and validation

1. Add the shared resolver and baseline contract, with pure tests for prefix matching, invalidation, suffix accounting, and invalid usage.
2. Capture/persist the baseline with completed ledger usage; verify provider normalization and tool catalog parity.
3. Route active decisions and durable snapshots through the resolver; delete the old diagnostic delta path.
4. Update UI provenance/composition semantics and audit mobile decoding/display.
5. Run a short real browsing turn and restart/reconstruct it. Compare pre-request estimate with the following actual usage without logging page content.

Tests must cover identical totals for active/durable paths, cached input counted once, reasoning not double-counted, user arrival during a call, compaction/model/tool changes, missing usage, old metadata, and unchanged compaction thresholds. Use sanitized numeric fixtures from the comparison above as evidence, not a promise of exact suffix estimates.

## Ownership, contracts, and rollout

The thread owns context accounting; existing authenticated thread authorization remains the entry point for browser reads. Ledger lookups remain thread-scoped, and new metadata inherits the existing call's owner stamping. No new route, global usage read, daemon request, or permission model is needed.

Service-only accounting works with existing daemons; neither mixed service/daemon pairing needs a capability gate or daemon upgrade. No schema migration is planned because the small anchor fits existing JSON metadata. If implementation requires a schema change, stop and revise this scope to include the normal migration workflow.

Existing REST/SSE context snapshots carry the result. Verify old client behavior explicitly, particularly category percentages and basis labels; ship required client presentation changes with the accounting change rather than leaving misleading breakdowns.

## Documentation to update during implementation

- [x] `service/src/agent/agent.spec.md`: shared accounting and fallback behavior.
- [x] `service/src/llm/llm.spec.md`: request baseline persistence and normalized usage semantics.
- Not applicable: provider adapters and their contracts are unchanged.
- [x] `web/src/components/workbench/workbench.spec.md`: utilization versus estimated composition.
- [x] `web/src/lib/lib.spec.md` and `docs/proto.md` if snapshot fields/basis semantics change.
- Not applicable: mobile consumes existing primary totals and needs no client change.
- [x] Existing context-meter/breakdown plans: supersede the parallel diagnostic and category-sum assumptions.

## Implementation and validation (2026-09-16)

- Baseline stored atomically at `llm_call.cache_metadata.context_baseline`; no schema migration, backfill or daemon upgrade.
- One resolver drives meter and compaction, with the actual tool catalog and shared environment instructions. Removed timestamp-selected provider deltas and raw output addition.
- Browser image artifact hydration can change with expiry/history limits, so requests containing those references conservatively fall back. Generic chat-completions providers also fall back because their turn-scoped reasoning serialization can change an existing prefix. OpenAI, Anthropic and ds4 Responses input usage are supported.
- Web labels and normalizes estimated composition independently. Mobile uses existing primary totals/percentages and string basis fields, not category totals; no mobile edits required. Provider adapters are unchanged.
- Service and web builds passed. Focused service tests: 79/79; web meter tests: 13/13. Coverage includes baseline persistence/reload, JSONB key ordering, compatibility invalidation, cache input normalization and active/durable total parity.
- Removed the migration-era retired-vocabulary prompt test at user request; the remaining conversation-loader tests pass. See [validation note](../debug/provider-anchored-context-validation.md).
- Live follow-up: run an ordinary text-snapshot browsing turn, then reload/reconstruct the meter. Expect provider input plus estimated additions when the prefix matches; changed replay content must fall back. No provider calls or user thread mutations were made just to validate the UI.
