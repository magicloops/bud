# Phase 12: Shared Budget State Helper

**Status**: Planned
**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/authoritative-context-budget-state.md](../../design/authoritative-context-budget-state.md)

---

## Goal

Extract one service-owned helper that builds the context budget state used by
both automatic compaction decisions and `/agent/state.context_budget`.

The helper should make estimate drift difficult by construction.

## Outcomes

- `AgentService.compactConversationIfNeeded(...)` and durable agent-state
  snapshots share the same primary estimate builder.
- The primary estimate remains `model_agnostic_estimate` until the backend
  trigger intentionally adopts a different basis.
- Provider usage plus delta moves to optional diagnostics.
- Compaction decision logs, runtime snapshots, and API snapshots use the same
  budget field names.

## Scope

- `service/src/agent/context-budget-state.ts` or equivalent helper module
- `service/src/agent/context-budget-snapshot.ts`
- `service/src/agent/agent-service.ts`
- focused service tests

## Non-Goals

- active runtime storage
- web UI updates
- changing estimator math beyond centralization
- fixed tool-schema overhead allowance

## Proposed Module

Create:

```text
service/src/agent/context-budget-state.ts
```

Candidate responsibilities:

- accept a selected model, resolved reasoning, provider, request phase, reason,
  turn id, and `CanonicalMessage[]`
- resolve `ContextBudget`
- compute the primary estimate with the same estimator used for compaction
- build a client-safe available or unknown context budget snapshot
- optionally attach provider usage diagnostics supplied by the durable snapshot
  path

Candidate public helpers:

```typescript
buildContextBudgetStateFromConversation(args): ContextBudgetSnapshot
buildContextBudgetDecision(args): {
  snapshot: ContextBudgetSnapshot
  shouldCompact: boolean
}
```

The exact function names can follow local conventions, but the key invariant is:

```text
AgentService compaction decision estimate === context_budget primary estimate
```

## Tasks

### Task 1: Extract Primary Builder

Move common snapshot math into the shared helper:

- budget validation
- `effective_budget_tokens`
- `estimated_input_tokens`
- `remaining_context_tokens`
- `percent_of_context_budget`
- `percent_of_model_window`
- `basis`
- `confidence`
- provenance fields

### Task 2: Update Agent Compaction Decision

Change `compactConversationIfNeeded(...)` to:

1. build the context budget decision from the active `conversation`
2. store/log the snapshot fields
3. call `shouldCompactContext(...)` using the snapshot's primary estimate

The actual compaction decision should not change relative to current behavior.
The refactor only makes the decision reusable and observable.

### Task 3: Update Durable Snapshot Builder

Change `getThreadContextBudgetSnapshot(...)` so the primary fields come from
the shared helper.

Durable reconstruction may still load provider usage anchors, but those should
be attached as `provider_usage_estimate` diagnostics.

### Task 4: Preserve Unknown Behavior

Unknown snapshots should still return safe reasons:

- `unknown_model_context_window`
- `invalid_context_policy`
- `conversation_unavailable`
- `count_failed`

No helper should throw raw prompt, checkpoint, or provider-ledger details into
browser responses.

### Task 5: Update Tests

Add or update tests proving:

- agent compaction skip decision and snapshot agree
- durable `/agent/state` snapshot and active decision builder agree on the same
  conversation input
- provider diagnostics do not affect `shouldCompact`
- invalid model policy returns unknown

## Test Plan

Run focused service tests:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/agent/context-budget*.test.ts src/agent/agent-service.test.ts
```

Run type check:

```bash
pnpm --dir /Users/adam/bud/service exec tsc --noEmit --project tsconfig.json
```

## Risks

| Risk | Mitigation |
|------|------------|
| Helper grows too broad | Keep authorization and route loading outside; helper receives already-resolved inputs |
| Agent behavior changes unintentionally | Preserve `estimateCanonicalMessagesTokens(...)` as the primary trigger estimate |
| Provider diagnostics become hidden control flow | Keep diagnostics optional and excluded from `shouldCompact` |

## Acceptance Criteria

- One shared helper owns primary context budget state construction.
- `AgentService` compaction decision uses that helper.
- `/agent/state.context_budget` durable snapshots use that helper.
- Tests prove provider usage diagnostics cannot make the primary meter exceed
  threshold when the backend trigger estimate is below threshold.
