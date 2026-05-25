# Phase 15: Calibration And Trigger Estimator Follow-Up

**Status**: Tool-Schema Overhead In Progress
**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/authoritative-context-budget-state.md](../../design/authoritative-context-budget-state.md)

---

## Goal

Measure and optionally reduce the gap between the model-agnostic trigger
estimate and provider usage diagnostics without changing the product contract.

This phase is intentionally after the authoritative contract work. The UI should
already match the backend trigger before estimator calibration begins.

## Outcomes

- logs/tests can compare trigger estimates with provider usage diagnostics
- fixed normal-agent tool-schema overhead is added to the trigger estimator
- the team can decide later whether remaining request overhead should be added
  to the trigger estimator
- any future provider-usage trigger behavior is an explicit backend decision,
  not accidental UI drift

## Scope

- diagnostic logging
- estimator tests
- normal-agent tool-schema estimator tuning
- optional follow-up estimator tuning for remaining request overhead
- optional design follow-up for provider/token-count trigger modes

## Non-Goals

- provider token-count API implementation
- local tokenizer adapters
- local model metadata design
- changing the primary UI contract
- manual compaction controls

## Current Hypothesis

The observed provider-vs-trigger delta may be partly explained by request
overhead that the model-agnostic estimator does not count:

- current tool schemas
- provider request framing
- system/developer prompt wrapper overhead
- provider tokenizer differences
- hidden or non-replayable output/reasoning tokens in provider usage

The simplified first step is to include the static normal-agent tool schemas in
the trigger estimate because every ordinary agent provider request carries them.
Broader provider request-envelope overhead should still be measured before any
additional compaction behavior changes.

## Tasks

### Task 1: Add Side-By-Side Diagnostics

When provider usage diagnostics are available, log a compact comparison:

- trigger estimate
- provider usage diagnostic estimate
- delta tokens
- delta ratio
- model/provider/reasoning
- threshold tokens
- whether a checkpoint is active

Do not log prompt text, tool schemas, summaries, replacement history, provider
request bodies, or raw provider outputs.

### Task 2: Include Tool Schema Allowance

Estimate the static current normal-agent tool-schema cost using the
model-agnostic estimator over the canonical tool definitions.

Compare:

```text
trigger_estimate
trigger_estimate + tool_schema_allowance
provider_usage_diagnostic
```

Include this allowance in:

- active pre-turn/mid-turn compaction decisions
- durable `/agent/state.context_budget` snapshots
- post-compaction `context_budget` snapshots
- context-budget tooltips as a message-vs-tool-schema split

Do not include the normal-agent tool-schema allowance in compaction-summary
requests because those calls intentionally use no tools.

### Task 3: Optional Estimator Adjustment

If further measurement supports it, update the trigger estimator with an
explicit, well-named additional overhead field such as:

```typescript
request_overhead_tokens
```

Rules:

- keep it provider-agnostic unless there is strong evidence otherwise
- expose it in debug logs
- keep tests around the reported regression
- update context budget snapshots so UI and trigger remain aligned

### Task 4: Optional Provider-Usage Trigger Decision

If provider diagnostics prove much safer than the model-agnostic estimate, draft
a separate design before making provider usage drive compaction.

That design must answer:

- which providers/models are eligible
- how active in-memory deltas are counted
- how reasoning/output tokens are treated
- how provider/model/reasoning changes invalidate anchors
- how local models fall back

## Test Plan

Backend:

- estimator unit tests around tool-schema overhead math
- regression test proving UI primary and backend trigger stay aligned
- diagnostics tests only if log shape is stable enough to assert safely

Manual:

- reproduce low-threshold GPT-5.5 scenario
- compare provider diagnostic and trigger estimate before/after any overhead
  adjustment
- confirm compaction still occurs only when authoritative trigger estimate
  crosses threshold

## Risks

| Risk | Mitigation |
|------|------------|
| Overhead causes excessive early compaction | Measure before changing; keep adjustment explicit and test thresholds |
| Provider diagnostics become hidden trigger behavior | Require a separate design for provider-usage trigger mode |
| Logs expose sensitive prompt/tool data | Log only counts, ratios, ids, and model metadata |

## Acceptance Criteria

- The system can explain trigger-vs-provider estimate deltas with safe logs.
- Any estimator adjustment is explicit, tested, and reflected in the same
  primary `context_budget` fields the UI uses.
- Provider usage remains diagnostic unless a future design intentionally changes
  the trigger basis.
