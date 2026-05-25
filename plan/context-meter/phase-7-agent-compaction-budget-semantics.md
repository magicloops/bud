# Phase 7: Agent Compaction Budget Semantics

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented
**Design Doc**: [../../design/usable-context-window-and-output-reserve.md](../../design/usable-context-window-and-output-reserve.md)

---

## Objective

Move automatic compaction and compaction-summary trimming from hard model window
math to the resolved usable input budget.

By the end of this phase:

- normal agent turns compact at `compactionThresholdTokens`
- disabled auto-compaction uses `usableInputWindowTokens` as the effective meter
  limit
- compaction summary calls trim to `usableInputWindowTokens`, not the proactive
  threshold
- logs and diagnostics clearly distinguish hard window, usable window, reserve,
  usable input, and threshold

## Scope

### In Scope

- `ContextBudget` shape updates
- agent pre-turn and mid-turn compaction checks
- compaction summary input trimming budget
- disabled auto-compaction effective limit behavior
- focused service tests

### Out Of Scope

- changing provider request `maxOutputTokens`
- per-call output reserve inference
- new SSE events
- manual compaction UI

## Implementation Tasks

### Task 1: Expand `ContextBudget`

Include these fields in the internal budget object:

- `contextWindowTokens`
- `usableContextWindowTokens`
- `reservedOutputTokens`
- `usableInputWindowTokens`
- `ratio`
- `thresholdTokens`
- `enabled`

Keep `contextWindowTokens` as diagnostic hard-window metadata. Use
`usableInputWindowTokens` for effective budget behavior when compaction is
disabled.

### Task 2: Update automatic compaction checks

Normal agent requests should compact when:

```text
estimatedNextInputTokens >= thresholdTokens
```

Where:

```text
thresholdTokens = floor(usableInputWindowTokens * ratio)
```

For GPT-5.5 at the default policy, a 260k estimated input should compact and a
250k estimated input should not.

### Task 3: Update compaction summary trimming

Let the budget resolver distinguish:

- `requestKind: "agent_turn"`
- `requestKind: "compaction_summary"`

For `agent_turn`, the effective input budget remains `thresholdTokens`.

For `compaction_summary`, the effective input budget is
`usableInputWindowTokens`. This gives the recovery path the extra headroom that
normal turns intentionally leave unused.

Output reserve still defaults to `maxOutputTokens` unless a model catalog entry
explicitly overrides `reservedOutputTokens`. Do not infer a smaller reserve from
the compaction summary request's current `maxOutputTokens`.

### Task 4: Preserve safe degraded behavior

If policy resolution reports an invalid usable input window:

- context meter snapshots should return `status: "unknown"`
- agent code should log the invalid policy
- provider calls should not crash solely because budget reporting failed

If a provider later rejects an oversized request, that remains a provider-call
error path.

### Task 5: Add compaction behavior tests

Cover:

- normal compaction threshold uses usable input, not hard window
- disabled auto-compaction effective budget uses usable input
- compaction summary trimming uses usable input instead of threshold
- GPT-5.5 250k/260k estimated-input behavior
- invalid policy does not crash snapshot generation

## Files Likely Changed

- `service/src/agent/context-budget.ts`
- `service/src/agent/agent-service.ts`
- `service/src/agent/context-compactor.ts`
- `service/src/agent/context-budget-snapshot.ts`
- `service/src/agent/*.test.ts`
- `service/src/agent/agent.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Compaction summary still fails near the threshold | Medium | High | Trim summary calls to usable input window instead of proactive threshold |
| Disabled compaction meter overstates available room | Medium | Medium | Use usable input window, not hard context window |
| Logs become ambiguous | Medium | Low | Include hard, usable, reserve, input, and threshold fields |

## Exit Criteria

- Agent compaction behavior derives from usable input policy.
- Compaction summary requests get the larger usable-input budget.
- Disabled auto-compaction uses usable input as the effective meter limit.
- Tests cover GPT-5.5 threshold behavior and invalid policy fallback.
