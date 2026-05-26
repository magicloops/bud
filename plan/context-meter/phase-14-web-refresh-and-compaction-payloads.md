# Phase 14: Web Refresh And Compaction Payloads

**Status**: Planned
**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/authoritative-context-budget-state.md](../../design/authoritative-context-budget-state.md)

---

## Goal

Update the client contract and web route so the send-button context ring uses
authoritative backend budget state from `/agent/state` and immediately applies
post-compaction budget snapshots when available.

## Outcomes

- `agent.compaction_done` may carry an optional `context_budget` snapshot.
- web applies `agent.compaction_done.context_budget` immediately when present.
- web continues to refresh `/agent/state` after send, model changes, resync,
  final, and cancel.
- provider usage diagnostics are not rendered in the product context tooltip.

## Scope

- service compaction event payload shape
- `docs/proto.md` if SSE event shape changes
- `web/src/lib/api-types.ts`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/components/workbench/context-budget-meter-state.ts`
- `web/.env.example`
- web tests and specs

## Non-Goals

- adding a standalone `agent.context_budget` SSE event
- showing provider diagnostics in the product context tooltip
- moving the context ring out of the send button
- manual compaction controls

## Service Contract

Extend `agent.compaction_done` additively:

```typescript
type ApiAgentCompactionDoneEvent = ApiAgentCompactionStartEvent & {
  checkpoint_id: string
  tokens_after: number
  finished_at: string
  context_budget?: ApiContextBudget | null
}
```

The included snapshot should be the post-compaction authoritative budget state,
not provider usage diagnostics as primary meter math.

Existing clients can ignore the additive field.

## Tasks

### Task 1: Add Post-Compaction Snapshot

After a successful compaction:

- reload or use the post-compaction conversation state
- build authoritative context budget snapshot from the post-compaction state
- attach it to `agent.compaction_done`
- keep raw checkpoint summaries and replacement history out of the event

### Task 2: Update SSE/API Types

Update first-party types:

- `ApiContextBudget`
- `ApiAgentCompactionDoneEvent`
- provenance fields
- optional `provider_usage_estimate`

If the SSE event shape is considered protocol documentation, update
`docs/proto.md`.

### Task 3: Update Stream Hook

In `useAgentStream(...)`:

- parse the optional `context_budget`
- pass it through to the route in the compaction-done callback
- keep existing marker behavior unchanged
- do not add `agent.context_budget` handling

### Task 4: Update Route State

In `web/src/routes/$budId/$threadId.tsx`:

- apply `event.context_budget` immediately in `handleCompactionDone` when
  present
- keep fallback `/agent/state` refresh for missed/missing snapshots
- keep final and resync refreshes
- ensure cancel path refreshes `/agent/state` after cancel completes or after
  the final canceled event is processed

### Task 5: Update Tooltip Presentation

Update `context-budget-meter-state.ts` so:

- primary copy uses authoritative `estimated_input_tokens`
- stale/source/phase copy is clear but compact
- provider usage diagnostics do not render in product-facing copy
- unknown and invalid policy states remain stable

### Task 6: Add Web Tests

Update tests for:

- compaction-done event with `context_budget`
- tooltip omits provider diagnostics even when `provider_usage_estimate` is present
- ring percent stays based on `percent_of_context_budget`
- unknown/stale states still render

## Test Plan

Focused web tests:

```bash
pnpm --dir /Users/adam/bud/web exec node --experimental-strip-types --test src/components/workbench/context-budget-meter-state.test.ts
```

Web type/build check:

```bash
pnpm --dir /Users/adam/bud/web exec tsc --noEmit --project tsconfig.json
```

Service type check if SSE types changed:

```bash
pnpm --dir /Users/adam/bud/service exec tsc --noEmit --project tsconfig.json
```

## Risks

| Risk | Mitigation |
|------|------------|
| Compaction event gets too large | Include only compact budget fields, never raw summary/replacement history |
| Web relies solely on compaction event and misses it | Keep `/agent/state` refresh fallback |
| Diagnostics confuse normal users | Keep provider usage diagnostics out of the product tooltip |

## Acceptance Criteria

- Post-compaction UI can update immediately from `agent.compaction_done`.
- Missing post-compaction snapshot still recovers via `/agent/state`.
- Provider diagnostics are not shown in the product context tooltip.
- No standalone `agent.context_budget` SSE event is introduced.
