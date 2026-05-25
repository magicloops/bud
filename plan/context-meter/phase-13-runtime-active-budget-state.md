# Phase 13: Runtime Active Budget State

**Status**: Planned
**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Design Doc**: [../../design/authoritative-context-budget-state.md](../../design/authoritative-context-budget-state.md)

---

## Goal

Store the latest active context budget decision in `AgentRuntimeStateManager` so
`/agent/state` can report the backend's current budget truth during active
turns, after finalization, and after user cancellation.

## Outcomes

- active turns expose the latest backend budget decision without rebuilding from
  stale durable rows
- cancel/final refreshes return a context budget that is accurate for the next
  user turn
- no separate `AgentContextBudgetRuntimeStore` is introduced
- no per-sub-turn budget SSE event is required

## Scope

- `service/src/runtime/agent-runtime-state.ts`
- `service/src/agent/agent-service.ts`
- `service/src/routes/threads/agent.ts`
- runtime and agent-service tests
- runtime/agent specs

## Non-Goals

- adding `agent.context_budget` SSE events
- persisting budget snapshots to the database
- changing visible transcript behavior
- changing terminal or Bud daemon protocols

## Runtime Shape

Extend `AgentRuntimeSnapshot` with optional context budget:

```typescript
context_budget: ContextBudgetSnapshot | null
```

The runtime can store the already serialized client-safe snapshot. It should not
store raw `CanonicalMessage[]`, checkpoint summaries, provider request bodies,
or tool schema payloads.

Snapshot lifecycle:

- `startTurn(...)` clears any stale active-turn budget
- each compaction decision updates runtime `context_budget`
- `finishTurn(...)` may preserve the latest budget only if it is valid for the
  final durable state, otherwise the route should recompute durable state
- cancel path should leave the next `/agent/state` call with a useful budget,
  either from the latest active decision or from a durable recompute

## Tasks

### Task 1: Add Runtime Field And Mutators

Add runtime methods such as:

```typescript
setContextBudget(threadId, contextBudget, cursor?)
clearContextBudget(threadId, cursor?)
```

Implementation details can vary, but tests should prove:

- `getSnapshot(...)` serializes `context_budget`
- `startTurn(...)` clears stale idle budget
- `finishTurn(...)` does not expose a mismatched active budget
- cursor behavior stays compatible with existing bounded replay semantics

### Task 2: Write Latest Decision During Agent Flow

In `AgentService.compactConversationIfNeeded(...)`, after building the shared
budget decision:

- store it on runtime with `source: "active_agent_decision"`
- include phase, reason, turn id, and checked timestamp
- update it for both skip and compaction paths
- update it for forced context-error retry decisions

### Task 3: Make Agent State Prefer Runtime Budget

In `GET /api/threads/:threadId/agent/state`:

- read runtime snapshot after authorization
- if runtime snapshot has an active budget for the current turn, return it
- otherwise compute durable reconstruction budget as today
- while active and no runtime budget exists yet, return durable snapshot with
  `stale: true`

### Task 4: Handle Cancel And Final Paths

Ensure cancel/final flows leave `/agent/state.context_budget` accurate for the
next user turn.

Preferred behavior:

- after normal final response, existing web refresh calls `/agent/state`, which
  recomputes durable state if the runtime is idle
- after cancel, `/agent/state` should not keep a stale active-only budget if
  persisted assistant/tool rows changed after the last budget decision
- when uncertain, prefer durable recomputation over preserving active state

### Task 5: Add Tests

Backend tests should cover:

- runtime snapshot includes context budget
- active budget wins over durable provider-usage diagnostics
- final/idle state returns durable trigger-aligned budget
- cancellation does not leave a stale over/under budget in runtime

## Test Plan

Run focused runtime and agent tests:

```bash
pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/runtime/agent-runtime-state.test.ts src/agent/agent-service.test.ts src/agent/context-budget*.test.ts
```

Run service type check:

```bash
pnpm --dir /Users/adam/bud/service exec tsc --noEmit --project tsconfig.json
```

## Risks

| Risk | Mitigation |
|------|------------|
| Runtime state becomes too domain-specific | Store only client-safe context budget snapshot; avoid raw conversation data |
| Stale budget survives final/cancel | Clear or recompute on idle transitions; add explicit tests |
| Cursor semantics regress | Preserve existing event/cursor behavior and cover in runtime tests |

## Acceptance Criteria

- `/agent/state` can return active backend budget decisions during a running
  turn.
- Final and cancel refresh paths return a budget suitable for the next user
  turn.
- No separate budget runtime store is added.
- No new standalone budget SSE event ships in this phase.
