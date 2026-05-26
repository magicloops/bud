# Phase 3: API And Agent State Contract

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Planned

---

## Objective

Expose the backend context budget snapshot to first-party clients through authorized thread APIs.

By the end of this phase:

- `/agent/state` includes `context_budget`
- first-party API types know the snapshot union
- ownership tests cover the new read path
- no dedicated context-budget SSE event is added

## Scope

### In Scope

- `GET /api/threads/:threadId/agent/state` response update
- optional thread bootstrap response update if Phase 0 selected it
- TypeScript API type updates
- route tests for owner/non-owner access
- degraded-state behavior

### Out Of Scope

- web visual meter
- new SSE events
- manual compaction route
- provider token-count API refresh route

## Implementation Tasks

### Task 1: Add `context_budget` to agent state

Extend the agent-state route response with:

```typescript
context_budget: ApiContextBudgetSnapshot | ApiContextBudgetUnknown
```

The route must compute the snapshot after authorizing the thread.

If snapshot computation fails unexpectedly, return a `status: "unknown"` snapshot with `reason: "count_failed"` rather than failing the entire agent-state response unless the authorization/thread lookup itself failed.

### Task 2: Decide and implement bootstrap inclusion

If Phase 0 chose bootstrap inclusion, add the same `context_budget` object to the relevant thread detail/bootstrap payload.

If not, document that clients should fetch `/agent/state` after opening a thread.

### Task 3: Update web API types

Add discriminated union types in `web/src/lib/api-types.ts`:

- `ApiContextBudgetSnapshot`
- `ApiContextBudgetUnknown`
- `ApiContextBudget`

Add `context_budget` to `ApiAgentState`.

### Task 4: Add ownership tests

Confirm:

- owner receives snapshot
- unauthenticated request receives `401`
- authenticated non-owner receives `404`
- snapshot does not expose raw checkpoint summary, replacement history, prompt text, or provider ledger payloads

### Task 5: Keep SSE unchanged

Do not add `context.budget` events.

If existing stream clients receive agent-state refresh on reconnect only, ensure the web phase has a strategy to refresh after message send or final state.

## Files Likely Changed

- `service/src/routes/threads/`
- `service/src/runtime/agent-runtime-state.ts`
- `web/src/lib/api-types.ts`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `service/src/runtime/runtime.spec.md`
- `web/src/lib/lib.spec.md`

## Exit Criteria

- Authorized agent-state responses contain `context_budget`.
- Non-owner access remains blocked.
- First-party API types compile.
- No new SSE contract exists.
