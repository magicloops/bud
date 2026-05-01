# Phase 8: Provider Ledger Atomicity

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented
**Source Review**: [../../review/fortify-llm-call-handling-branch-review.md](../../review/fortify-llm-call-handling-branch-review.md)

---

## Objective

Make provider-ledger writes atomic so the replay source of truth cannot persist a completed call without its ordered output items.

`recordLlmCall(...)` currently inserts `llm_call` first and `llm_call_item` rows second. If item insertion fails, the durable ledger can say a provider call completed while storing no replay payload. This phase closes that integrity gap and makes diagnostics expose any existing partial rows.

## Scope

### In Scope

- transaction around `llm_call` and initial output `llm_call_item` inserts
- diagnostics that count call rows even when item rows are missing
- tests for rollback when item insertion fails
- tests or fixtures for itemless completed-call diagnostics
- clear handling for legitimate zero-output provider responses

### Out Of Scope

- wrapping terminal tool execution in the provider-ledger transaction
- changing product transcript message persistence order unless required for rollback correctness
- backfilling or repairing production rows without a separate migration/runbook
- changing the append-only provider-ledger schema unless implementation proves it is required

## Implementation Tasks

1. Wrap the `llm_call` insert and initial output item inserts in a single database transaction.
2. Keep `recordLlmToolResultItem(...)` outside that transaction because tool results are produced after tool execution and are separate input items for the next provider call.
3. Ensure an item-insert failure rolls back the `llm_call` row and does not leave `status = "completed"` without replay items.
4. Update provider-ledger diagnostics to use call rows as the base relation, not an inner join that hides itemless calls.
5. Distinguish three states in diagnostics:
   - completed call with output items
   - completed call with zero output items, if intentionally allowed
   - completed call missing expected item rows
6. Add tests that simulate item insertion failure and assert rollback behavior.
7. Add tests for diagnostics on a completed call with no item rows.
8. Confirm no schema migration is needed, or document and generate one if a new status/metadata field is required.

## Acceptance Criteria

- [x] `recordLlmCall(...)` commits the call row and output item rows atomically.
- [x] Failed output item insertion leaves no completed `llm_call` row behind.
- [x] Provider-ledger diagnostics report itemless completed calls instead of hiding them.
- [x] Zero-output/outputless completed-call states are surfaced as diagnostics rather than silently treated as valid replay rows.
- [x] Tests cover transaction rollback and itemless-call diagnostics.

## Risks

| Risk | Mitigation |
|------|------------|
| Test harness makes insert-failure simulation brittle | Prefer a small injected transaction/test seam over relying on database-specific constraint tricks |
| Transaction scope accidentally includes tool execution | Keep the transaction limited to call metadata plus initial output items |
| Existing itemless rows are discovered | Surface them in diagnostics first; handle repair/backfill through a separate runbook if needed |
| Empty-output calls are conflated with partial writes | Represent intentional empty output explicitly in metadata or status before treating it as valid |
