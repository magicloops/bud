# Phase 11: Authoritative Budget Contract And Tests

**Status**: Planned
**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/authoritative-context-budget-state.md](../../design/authoritative-context-budget-state.md)

---

## Goal

Lock the context-budget contract so the primary meter reflects the same estimate
the backend uses for automatic compaction decisions.

This phase is intentionally contract-first. It should make the mismatch
testable before larger refactors land.

## Outcomes

- `context_budget.estimated_input_tokens` is defined as the backend's
  authoritative model-visible input estimate against the effective compaction
  budget.
- Provider usage plus delta is no longer a primary meter basis unless the agent
  trigger also uses provider usage.
- Provider usage remains available only as optional diagnostics.
- Tests reproduce the reported mismatch and assert the UI-facing primary budget
  follows the backend trigger estimate.

## Scope

- service context-budget snapshot types and tests
- web API types and tooltip presentation tests
- design/spec wording around primary vs diagnostic estimates

## Non-Goals

- runtime active-budget storage
- web rendering changes beyond type/test expectations
- changing the compaction trigger estimator
- provider token-count APIs

## Contract Changes

Available snapshots should keep the existing top-level field name:

```typescript
estimated_input_tokens: number
```

Clarified meaning:

> The backend's authoritative estimate of model-visible input for the current
> effective compaction budget.

Add provenance fields:

```typescript
source:
  | "durable_reconstruction"
  | "active_agent_decision"
  | "compaction_event"
  | "unknown"
phase: "idle" | "pre_turn" | "mid_turn" | "standalone_turn" | null
reason: "context_limit" | "context_error_retry" | "model_downshift" | "user_requested" | null
turn_id: string | null
checked_at: string | null
```

Add optional diagnostic data:

```typescript
provider_usage_estimate?: {
  estimated_input_tokens: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens?: number
  delta_tokens: number
  llm_call_id: string
  confidence: "medium" | "high"
} | null
```

Primary `basis` values should no longer include
`provider_usage_plus_delta` unless the backend trigger uses provider usage:

```typescript
basis: "model_agnostic_estimate" | "provider_usage_trigger" | "provider_token_count"
```

## Tasks

### Task 1: Update Contract Tests

Add or update service tests proving:

- durable snapshots use `estimateCanonicalMessagesTokens(...)` as primary
  while the trigger does
- provider usage plus delta is reported only under diagnostic fields
- `percent_of_context_budget` is derived from the primary estimate
- checkpoint metadata still appears in available snapshots
- unknown snapshots remain unchanged and safe

Add a regression fixture matching the observed bug:

```text
canonical trigger estimate: 15,142
threshold: 27,200
provider usage diagnostic: about 35k
expected primary percent: about 56%
unexpected old primary percent: 128%
```

### Task 2: Update Web Types

Extend `web/src/lib/api-types.ts` with the provenance and diagnostic fields.

Keep `estimated_input_tokens`; do not rename it to
`estimated_trigger_tokens`.

### Task 3: Update Tooltip Presentation Tests

Update `context-budget-meter-state.test.ts` expectations so:

- primary copy is based on server `estimated_input_tokens`
- provenance can be shown when useful
- provider diagnostic copy is not shown by default
- provider diagnostic copy stays out of product-facing tooltip details

### Task 4: Update Specs

Update affected specs after implementation:

- `service/src/agent/agent.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `plan/context-meter/context-meter.spec.md`

## Test Plan

Service:

- context budget snapshot unit tests
- no route auth changes expected in this phase

Web:

- context budget presentation tests
- type check if API unions change broadly

## Risks

| Risk | Mitigation |
|------|------------|
| Contract churn breaks web/mobile assumptions | Keep field name `estimated_input_tokens`; add fields additively where possible |
| Provider diagnostics are mistaken for product truth | Move them under `provider_usage_estimate` and keep them out of the product tooltip |
| Tests encode implementation details too tightly | Assert public snapshot fields and primary percent, not private helper internals |

## Acceptance Criteria

- Service tests prove provider usage diagnostics do not affect the primary
  budget percent.
- Web types represent the authoritative-budget contract.
- The reported mismatch has a regression test.
- Specs reflect the clarified meaning of `estimated_input_tokens`.
