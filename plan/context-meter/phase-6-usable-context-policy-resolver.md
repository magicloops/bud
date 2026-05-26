# Phase 6: Usable Context Policy Resolver

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented
**Design Doc**: [../../design/usable-context-window-and-output-reserve.md](../../design/usable-context-window-and-output-reserve.md)

---

## Objective

Add a shared model context policy resolver that separates provider hard context
window metadata from Bud's usable input budget.

By the end of this phase:

- model catalog entries can declare a Bud usable context cap
- output reserve defaults to `maxOutputTokens`
- GPT-5.5 has the Codex-style 400k usable context cap and 128k reserve
- the global automatic-compaction ratio clamp can rise from `0.9` to `0.95`
- invalid or missing policy produces a safe unknown budget state

## Scope

### In Scope

- additive model catalog fields
- default policy resolution
- `0.95` maximum ratio clamp
- GPT-5.5 catalog policy
- unit tests for policy math and invalid policy handling

### Out Of Scope

- API response changes
- web UI changes
- provider token-count APIs
- local tokenizer integration
- per-model compaction ratio override

## Implementation Tasks

### Task 1: Extend model catalog capabilities

Add optional fields to `ModelCatalogEntry.capabilities`:

- `usableContextWindowTokens?: number`
- `reservedOutputTokens?: number`

Keep `contextWindowTokens` as the provider/model hard context window. Do not
redefine it as Bud's usable window.

### Task 2: Add one policy resolver

Add or extend a single resolver that returns:

- `contextWindowTokens`
- `usableContextWindowTokens`
- `reservedOutputTokens`
- `usableInputWindowTokens`
- `compactionThresholdRatio`
- `compactionThresholdTokens`

Default rules:

```text
usableContextWindowTokens = usableContextWindowTokens ?? contextWindowTokens
reservedOutputTokens = reservedOutputTokens ?? maxOutputTokens
usableInputWindowTokens = usableContextWindowTokens - reservedOutputTokens
compactionThresholdTokens = floor(usableInputWindowTokens * compactionThresholdRatio)
```

If the usable input window is missing, zero, or negative, return an unknown or
invalid policy result instead of crashing route code or the composer.

### Task 3: Raise the ratio clamp

Change `AGENT_AUTO_COMPACTION_RATIO` clamping so values above `0.95` clamp to
`0.95`.

The ratio remains configurable below that cap. Do not add a per-model override
in this phase, but keep the resolver shape compatible with one later.

### Task 4: Configure GPT-5.5

Set GPT-5.5 policy to:

```text
contextWindowTokens = 1,050,000
usableContextWindowTokens = 400,000
maxOutputTokens = 128,000
reservedOutputTokens = 128,000
usableInputWindowTokens = 272,000
compactionThresholdTokens = 258,400
```

The important behavior is the derived budget:

```text
0.95 * (400,000 - 128,000) = 258,400
```

### Task 5: Add policy tests

Cover:

- models without overrides default usable context to hard context window
- models without reserve overrides default reserve to `maxOutputTokens`
- GPT-5.5 derives a 272k usable input window
- GPT-5.5 derives a 258,400 threshold at the `0.95` clamp
- invalid policy where reserve exceeds usable window returns a safe unknown or
  invalid result

## Files Likely Changed

- `service/src/llm/model-catalog.ts`
- `service/src/agent/context-budget.ts`
- `service/src/agent/*.test.ts`
- `service/src/llm/llm.spec.md`
- `service/src/agent/agent.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Existing callers assume `contextWindowTokens` is the budget | Medium | High | Keep hard-window semantics and add explicit usable fields |
| Formula spreads into routes or web code | Medium | Medium | Serialize resolver output and forbid client-side threshold math |
| Invalid local model metadata breaks UI | Medium | Medium | Return unknown context policy instead of throwing |

## Exit Criteria

- Shared resolver owns all usable context and output reserve math.
- GPT-5.5 policy matches the Codex-style formula.
- The global ratio clamp is `0.95`.
- Tests cover defaults, overrides, and invalid policy.
