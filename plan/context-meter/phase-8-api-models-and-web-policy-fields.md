# Phase 8: API Models And Web Policy Fields

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented
**Design Doc**: [../../design/usable-context-window-and-output-reserve.md](../../design/usable-context-window-and-output-reserve.md)

---

## Objective

Expose resolved usable-context policy fields to first-party clients and update
the context meter details so the UI matches the new budget semantics.

By the end of this phase:

- `/api/models` exposes hard window, usable window, output reserve, and usable
  input window
- `/agent/state.context_budget` includes the same policy fields
- web types understand the new snake_case fields
- the meter still uses service-provided percentages instead of recomputing
  thresholds client-side
- missing or invalid local model policy renders `Context unknown`

## Scope

### In Scope

- `/api/models` capability fields
- `context_budget` snapshot fields
- first-party API types
- context meter tooltip/details copy
- unknown policy UI behavior
- route/type/component tests where practical

### Out Of Scope

- dedicated `context.budget` SSE event
- manual compaction action
- provider token-count refresh endpoint
- local model metadata design beyond safe unknown behavior

## Implementation Tasks

### Task 1: Extend `/api/models`

Add these snake_case capability fields:

- `context_window_tokens`
- `usable_context_window_tokens`
- `reserved_output_tokens`
- `usable_input_window_tokens`
- `max_output_tokens`

`usable_input_window_tokens` must be serialized by the service so clients do not
duplicate policy math.

### Task 2: Extend `context_budget` snapshots

For `status: "available"`, include:

- `context_window_tokens`
- `usable_context_window_tokens`
- `reserved_output_tokens`
- `usable_input_window_tokens`
- `compaction_threshold_ratio`
- `compaction_threshold_tokens`
- `effective_budget_tokens`
- `estimated_input_tokens`
- `remaining_context_tokens`
- `percent_of_context_budget`
- `percent_of_model_window`

When auto-compaction is disabled, `effective_budget_tokens` should be
`usable_input_window_tokens`, not the hard context window.

For invalid or missing policy metadata, return `status: "unknown"` with a reason
such as `invalid_context_policy` or `unknown_model_context_window`.

### Task 3: Update web types

Update first-party TypeScript types for:

- model capabilities
- available context budget snapshot
- unknown context budget snapshot reason values

Keep API field names in snake_case at the boundary.

### Task 4: Update meter details

The compact visual remains percentage-first and should use
`percent_of_context_budget`.

Tooltip/details should show:

- hard model window
- Bud usable window
- output reserve
- usable input window
- compaction threshold
- estimate basis/confidence

Example copy:

```text
185k used of 258k before auto-compact.
Bud cap 400k, output reserve 128k.
Hard model window 1.05m.
```

Do not show raw checkpoint ids, raw prompt text, or provider ledger payloads.

### Task 5: Handle unknown policy states

If context policy is missing or invalid, the composer should show `Context
unknown` or equivalent subdued copy. The meter should not hide the composer,
block message send, or throw.

## Files Likely Changed

- `service/src/routes/models.ts`
- `service/src/routes/threads/agent.ts`
- `service/src/agent/context-budget-snapshot.ts`
- `web/src/lib/api-types.ts`
- `web/src/lib/models.ts`
- `web/src/components/workbench/context-budget-meter.tsx`
- `web/src/components/workbench/context-budget-meter-state.ts`
- `service/src/routes/routes.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/components/workbench/workbench.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Client recomputes policy differently | Medium | Medium | Expose `usable_input_window_tokens` and use server percentages |
| UI shows too much technical detail | Medium | Low | Keep compact view percent-only; put rounded fields in details |
| Unknown local policy breaks composer | Medium | High | Render `Context unknown` and keep input usable |

## Exit Criteria

- `/api/models` exposes usable context policy fields.
- `context_budget` snapshots expose matching policy fields.
- Web meter details explain the new budget components.
- Unknown policy states are stable and non-blocking.
