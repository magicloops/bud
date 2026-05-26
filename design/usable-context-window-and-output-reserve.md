# Design: Usable Context Window And Output Reserve

Status: Implemented for phases 6-8

Audience: Backend, web/mobile clients, LLM-provider owners

Last updated: 2026-05-24

Related docs:

- [Conversation context budget meter](./conversation-context-budget-meter.md)
- [Context compaction](./context-compaction.md)
- [LLM model catalog and reasoning controls](./llm-model-catalog-and-reasoning-controls.md)
- [service/src/llm/llm.spec.md](../service/src/llm/llm.spec.md)
- [service/src/agent/agent.spec.md](../service/src/agent/agent.spec.md)

## 1. Goal

Split "model context window" into two different concepts:

1. **Hard context window**: the provider/model's advertised total context
   capacity.
2. **Bud usable context window**: the total context capacity Bud is willing to
   use for quality, latency, reliability, or product-policy reasons.

Bud should then reserve output tokens before calculating the input budget that
automatic compaction and the context meter use.

This avoids filling a model to its advertised context maximum when quality or
performance degrades earlier. GPT-5.5 is the first known case: although its
catalog entry currently has a 1,050,000 token hard context window, Codex-like
operation appears to use a much smaller effective cap based on the older 400,000
token window and a 128,000 output reserve.

Codex-style example:

```text
usable_context_window_tokens = 400,000
reserved_output_tokens = 128,000
usable_input_window_tokens = 400,000 - 128,000 = 272,000
compaction_threshold_tokens = floor(272,000 * 0.95) = 258,400
```

This design adopts `0.95` as the maximum automatic-compaction ratio for the
broader system. The resolver should still keep the ratio configurable, but the
upper clamp should move from the current implementation's `0.9` cap to `0.95`
so Bud can use the Codex-style budget formula without GPT-5.5-specific
conditionals throughout the agent or UI.

## 2. Original Implementation Review

Relevant code before this design's implementation:

- `service/src/llm/model-catalog.ts`
  - `ModelCatalogEntry.capabilities.contextWindowTokens` is the only catalog
    context-window field.
  - `ModelCatalogEntry.capabilities.maxOutputTokens` exists, but context budget
    math does not subtract it.
  - GPT-5.5 currently declares `contextWindowTokens: 1_050_000` and
    `maxOutputTokens: 128_000`.
- `service/src/agent/context-budget.ts`
  - `resolveContextBudget(...)` reads `contextWindowTokens` directly.
  - `thresholdTokens = floor(contextWindowTokens * AGENT_AUTO_COMPACTION_RATIO)`.
  - `AGENT_AUTO_COMPACTION_RATIO` is clamped to at most `0.9`.
- `service/src/agent/agent-service.ts`
  - `compactConversationIfNeeded(...)` compares
    `estimateCanonicalMessagesTokens(conversation)` against
    `budget.thresholdTokens`.
  - Logs `estimatedTokens`, `thresholdTokens`, and `contextWindowTokens`.
- `service/src/agent/context-compactor.ts`
  - The temporary compaction-summary request is trimmed against
    `budget.thresholdTokens`, which currently derives from the full context
    window.
- `service/src/agent/context-budget-snapshot.ts`
  - `/agent/state.context_budget` exposes `context_window_tokens`,
    `compaction_threshold_tokens`, and `effective_budget_tokens`.
  - It uses the same full-window-derived threshold as automatic compaction.
- `service/src/routes/models.ts` and `web/src/lib/models.ts`
  - `/api/models` exposes `capabilities.context_window_tokens` and
    `max_output_tokens`, but not a usable-window cap or output reservation.

Implementation status as of 2026-05-24:

- the model catalog supports `usableContextWindowTokens` and
  `reservedOutputTokens`
- GPT-5.5 uses a 400k usable context cap and 128k output reserve
- `AGENT_AUTO_COMPACTION_RATIO` clamps to `0.95`
- automatic compaction uses usable input budget
- compaction summary calls trim against the larger usable input window
- `/api/models` and `/agent/state.context_budget` expose the resolved
  usable-context policy fields

Problem:

`contextWindowTokens` currently does three jobs:

- provider hard limit metadata
- Bud's quality/performance usable limit
- compaction input-budget base

Those should be separate so the agent, context meter, and future local-model
support can share one policy without losing provider metadata.

## 3. Terminology

Use these terms consistently:

| Term | Meaning |
| --- | --- |
| `contextWindowTokens` | Provider/model hard total context window. Existing field. |
| `usableContextWindowTokens` | Bud's total context cap for this model before output reservation. Defaults to `contextWindowTokens`. |
| `reservedOutputTokens` | Tokens Bud reserves for the model response. Defaults to `maxOutputTokens`, with optional per-model overrides. |
| `usableInputWindowTokens` | Input budget before the compaction safety ratio: `usableContextWindowTokens - reservedOutputTokens`. |
| `compactionThresholdRatio` | Safety ratio applied to usable input budget. Existing global config is `AGENT_AUTO_COMPACTION_RATIO`. |
| `compactionThresholdTokens` | Proactive compaction threshold: `floor(usableInputWindowTokens * compactionThresholdRatio)`. |

Important distinction:

`usableContextWindowTokens` is still a total context window. It is not the input
budget. The input budget is lower after reserving output tokens.

## 4. Proposed Catalog Shape

Minimal first pass:

```typescript
export type ModelCatalogEntry = {
  // existing fields
  capabilities: {
    vision: boolean;
    tools: boolean;
    streaming: boolean;
    structuredOutputs: boolean;
    contextWindowTokens: number;
    maxOutputTokens: number;

    // new optional policy fields
    usableContextWindowTokens?: number;
    reservedOutputTokens?: number;
  };
  reasoning: ReasoningControl;
};
```

Default resolution:

```typescript
usableContextWindowTokens =
  entry.capabilities.usableContextWindowTokens
  ?? entry.capabilities.contextWindowTokens

reservedOutputTokens =
  entry.capabilities.reservedOutputTokens
  ?? entry.capabilities.maxOutputTokens
```

GPT-5.5 catalog intent:

```typescript
{
  id: "gpt-5.5",
  capabilities: {
    contextWindowTokens: 1_050_000,
    usableContextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    reservedOutputTokens: 128_000,
    // ...
  },
}
```

For models where Bud wants to use the provider's full hard window, omit
`usableContextWindowTokens`. For models where Bud wants to reserve less than the
provider maximum output, set `reservedOutputTokens` explicitly. If no override
is present, every catalog model should reserve `maxOutputTokens`.

### Future Shape

If more fields accumulate, move context policy into a nested object:

```typescript
contextPolicy: {
  usableContextWindowTokens?: number;
  reservedOutputTokens?: number;
  compactionThresholdRatio?: number;
}
```

Do not start with the nested object unless implementation pressure justifies it.
The current catalog `capabilities` object already owns context and output
limits, and a small optional extension is lower churn.

## 5. Budget Formula

Add one resolver that all budget users call:

```typescript
type ModelContextPolicy = {
  contextWindowTokens: number | null;
  usableContextWindowTokens: number | null;
  reservedOutputTokens: number | null;
  usableInputWindowTokens: number | null;
  compactionThresholdRatio: number;
  compactionThresholdTokens: number | null;
};
```

Formula:

```text
hard = contextWindowTokens
usable = usableContextWindowTokens ?? hard
reserved_output = reservedOutputTokens ?? maxOutputTokens
usable_input = max(0, usable - reserved_output)
threshold = floor(usable_input * compactionThresholdRatio)
```

If `usable_input <= 0`, treat the model as misconfigured for budget reporting and
automatic compaction:

- context meter returns `status: "unknown"` with a reason such as
  `invalid_context_policy`
- agent logs the catalog problem
- provider invocation should still use the provider normally unless the model
  selection itself is invalid

### Ratio Policy

Raise the global automatic-compaction ratio clamp from `0.9` to `0.95`.

- GPT-5.5 threshold from a 400k usable window and 128k reserve becomes
  `258,400`.
- The ratio should remain configurable through the existing environment setting,
  but values above `0.95` should be clamped to `0.95`.
- The resolver should still be structured so a future per-model ratio override
  can live in model context policy, not in ad hoc GPT-5.5 checks.

## 6. Agent And Compaction Semantics

Automatic compaction should compare the estimated next request input against
`compactionThresholdTokens`, not against the hard context window.

For normal agent turns:

```text
estimated_next_input_tokens >= compactionThresholdTokens
```

For GPT-5.5 with Codex-like policy:

```text
estimated_next_input_tokens >= 258,400
```

### Output Tokens

The existing Tier 1 meter estimate already adds latest provider
`usage.output_tokens` to approximate the next request input. That remains
correct. The output reserve is a separate capacity reservation for the future
response, not a replacement for counting previous assistant output as replayed
input.

In other words:

- previous output tokens may become next input tokens
- reserved output tokens protect space for the next response
- both matter

### Compaction Summary Calls

`context-compactor.ts` currently trims the compaction summary request against
the same `budget.thresholdTokens` used for normal agent calls.

This can become too aggressive because the proactive threshold intentionally
leaves a safety margin. Compaction summary calls are themselves the recovery
path, so they should be allowed to use the slightly larger usable input window
while still reserving output capacity.

Avoid debt by letting the budget resolver accept a request kind or explicit
input budget mode:

```typescript
resolveContextBudget({
  model,
  modelReasoning,
  requestKind: "agent_turn" | "compaction_summary",
})
```

For `agent_turn`, the effective budget is the proactive
`compactionThresholdTokens`.

For `compaction_summary`, the effective input budget should be
`usableInputWindowTokens`, not the proactive threshold. This gives the summary
request the extra safety margin that normal turns keep unused, which reduces the
chance that compaction fails immediately after crossing the auto-compact line.

Output reservation still defaults to `maxOutputTokens` unless the model catalog
sets `reservedOutputTokens` explicitly. Do not infer a smaller reserve from a
single call's requested `maxOutputTokens` in the first pass.

## 7. API And UI Contract

Extend `/api/models` capabilities with the new context policy fields:

```json
{
  "capabilities": {
    "context_window_tokens": 1050000,
    "usable_context_window_tokens": 400000,
    "reserved_output_tokens": 128000,
    "usable_input_window_tokens": 272000,
    "max_output_tokens": 128000
  }
}
```

`usable_input_window_tokens` can be derived client-side, but exposing it avoids
duplicating policy math in every client.

Extend `context_budget` snapshots:

```typescript
type ApiContextBudgetAvailable = {
  status: "available";
  context_window_tokens: number;          // hard provider/model window
  usable_context_window_tokens: number;   // Bud cap before output reserve
  reserved_output_tokens: number;
  usable_input_window_tokens: number;
  compaction_threshold_ratio: number;
  compaction_threshold_tokens: number;
  effective_budget_tokens: number;        // threshold if enabled, else usable input window
  estimated_input_tokens: number;
  remaining_context_tokens: number;
  percent_of_context_budget: number;
  percent_of_model_window: number;
};
```

Update UI copy:

- primary meter still uses `percent_of_context_budget`
- tooltip should show:
  - hard model window
  - Bud usable window
  - output reserve
  - usable input window
  - compaction threshold

Example tooltip for GPT-5.5:

```text
GPT-5.5: 72% of auto-compact limit
185k used of 258k.
Bud cap 400k, output reserve 128k.
Hard model window 1.05m.
```

If auto-compaction is disabled, `effective_budget_tokens` should be
`usable_input_window_tokens`, not the hard context window. Output reserve still
matters even without automatic compaction.

## 8. Implementation Direction

Recommended phase order:

1. Add catalog fields and a single policy resolver.
   - Keep provider hard-window metadata intact.
   - Add `usableContextWindowTokens` and `reservedOutputTokens` to
     `ModelCatalogEntry.capabilities`.
   - Add `resolveModelContextPolicy(...)` or extend `resolveContextBudget(...)`
     so all budget math goes through one function.
2. Update automatic compaction.
   - `ContextBudget` gains `usableContextWindowTokens`,
     `reservedOutputTokens`, and `usableInputWindowTokens`.
   - `thresholdTokens` is based on usable input.
   - Logs include both hard and usable fields.
3. Update context meter snapshot.
   - Add new snake_case fields.
   - Keep existing fields for compatibility.
   - `percent_of_model_window` remains diagnostic.
4. Update `/api/models` and web model types.
   - Expose hard, usable, reserve, and usable-input fields.
   - Existing clients can ignore the new fields.
5. Update tests and specs.
   - Catalog test for GPT-5.5 policy.
   - Budget test for the Codex-like formula.
   - Snapshot/UI tests for new fields and tooltip copy.

No database migration is required.

## 9. Technical Debt Risks And Avoidance

### Risk: Formula Duplication

If `/api/models`, `context-budget.ts`, `context-budget-snapshot.ts`, and web code
each compute usable input independently, the meter and compaction trigger will
drift.

Avoidance:

- one backend resolver owns the formula
- `/api/models` serializes resolver output
- web displays server fields and does not recompute thresholds

### Risk: Ambiguous "Usable Context"

People may interpret usable context as input-only budget.

Avoidance:

- name the total cap `usableContextWindowTokens`
- name the input budget `usableInputWindowTokens`
- include both in logs and snapshots

### Risk: Output Reserve Equals Max Output Forever

Using `maxOutputTokens` as the default reserve is safe but may be too
conservative for models where Bud never requests max output.

Avoidance:

- keep `reservedOutputTokens` explicit and per-model overrideable
- if smaller reserves are needed later, make them explicit catalog or runtime
  policy fields rather than inferring them from an individual request's
  `maxOutputTokens`

### Risk: Provider Cap vs Product Cap Confusion

Provider adapters still need the hard context window for capability reporting and
debugging. Agent budget policy needs the usable window.

Avoidance:

- do not change provider `ModelCapabilities.maxContextTokens` semantics without
  a separate provider API design
- keep `context_window_tokens` as hard window in `/api/models`
- add new fields instead of redefining existing ones

### Risk: Ratio Policy Hidden In Config

Changing the global clamp to `0.95` creates another policy value that can drift
if the agent, meter, and docs each encode it separately.

Avoidance:

- make ratio resolution part of the same policy object
- update `AGENT_AUTO_COMPACTION_RATIO` clamping in one resolver path
- keep `0.95` documented as the system maximum until a future per-model policy
  exists
- never special-case GPT-5.5 outside the catalog or resolver

### Risk: Local Models Lack Metadata

Future local models may have runtime-specific windows and output limits.

Avoidance:

- require local model descriptors to declare at least hard context window,
  usable context window default, and output reserve before showing a percentage
  meter
- if metadata is missing, return `status: "unknown"` rather than inventing a
  percentage; the meter should show `Context unknown` instead of hiding or
  failing

## 10. Testing Plan

Service:

- `resolveContextBudget(...)` computes GPT-5.5 policy:
  - hard window: 1,050,000
  - usable window: 400,000
  - reserved output: 128,000
  - usable input: 272,000
  - threshold: 258,400 at the 0.95 ratio clamp
- models without overrides default `usableContextWindowTokens` to
  `contextWindowTokens`
- models without overrides default `reservedOutputTokens` to `maxOutputTokens`
- invalid policy where reserved output exceeds usable window returns an unknown
  budget or throws a catalog test failure
- automatic compaction uses usable input threshold, not hard context window
- compaction summary trimming uses `usableInputWindowTokens`, not
  `compactionThresholdTokens`
- context meter snapshot includes new fields while preserving existing fields
- `/api/models` returns the new snake_case fields

Web:

- model type accepts new capability fields
- tooltip renders hard window, usable window, output reserve, and threshold
- visual percent still comes from `percent_of_context_budget`
- unknown policy state does not break the composer

Regression:

- construct a GPT-5.5 thread with an estimated 260k next input:
  - with the 0.95 ratio clamp, it should compact
- construct a GPT-5.5 thread with an estimated 250k next input:
  - with the 0.95 ratio clamp, it should not compact yet

## 11. Resolved Decisions

1. `reservedOutputTokens` defaults to `maxOutputTokens` for every catalog model.
   Specific models can override it in their catalog entry.
2. Compaction summary calls use the larger `usableInputWindowTokens` input
   budget instead of the normal proactive `compactionThresholdTokens` budget so
   compaction has room to succeed after the threshold is crossed. Output
   reservation still defaults to `maxOutputTokens` unless the model config
   explicitly changes it.
3. `/api/models` exposes `usable_input_window_tokens` so clients do not
   duplicate policy math.
4. Missing or invalid local-model context policy should show `Context unknown`
   rather than hiding the meter or failing the composer.

## 12. Recommendation

Implement the split now with additive fields and a shared resolver.

For GPT-5.5, set:

```text
contextWindowTokens = 1,050,000
usableContextWindowTokens = 400,000
reservedOutputTokens = 128,000
```

Then raise the global automatic-compaction ratio clamp from `0.9` to `0.95`.
The ratio can remain configurable below that cap, but the broader system should
allow Codex-style thresholds without model-specific branching.

The important architectural move is not the exact ratio. It is making the agent
and meter budget derive from:

```text
safety_ratio * (usable_context_window_tokens - reserved_output_tokens)
```

rather than:

```text
safety_ratio * hard_context_window_tokens
```
