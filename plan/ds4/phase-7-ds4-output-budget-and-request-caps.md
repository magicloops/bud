# Phase 7: ds4 Output Budget And Request Caps

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented
**Related Debug**: [../../debug/ds4-concurrency-ui-and-context-budget.md](../../debug/ds4-concurrency-ui-and-context-budget.md)

---

## Objective

Make ds4 context-budget metadata valid and align actual provider request output caps with selected-model capabilities.

The observed warning is caused by ds4 advertising a 100k context window with a 128k output reserve. The current context policy defaults `reservedOutputTokens` to `maxOutputTokens`, so the usable input window becomes invalid.

By the end of this phase:

- `ds4-deepseek-v4-flash` has a valid context policy
- ds4 output capability metadata reflects the DeepSeek model's 384k capability
- ds4 context-budget math uses an explicit 20k output reserve instead of defaulting to the model's max output
- model capability caps are applied generically by the model runner
- Bud-local capability projection does not display invalid output metadata
- tests cover catalog policy, request cap selection, and API model metadata

## Scope

### In Scope

- set ds4 catalog `maxOutputTokens` to `384000`
- add an explicit ds4 catalog `reservedOutputTokens`
- update direct service-local ds4 config defaults
- update Bud daemon ds4 advertised default metadata
- derive agent request `maxOutputTokens` from model/provider capabilities
- update docs, env examples, and ds4 plan examples
- validate `/api/models` context policy fields for direct and Bud-local ds4

### Out Of Scope

- dynamic per-request output cap based on live token estimation
- changing the automatic-compaction policy resolver globally
- clamping invalid context policies silently
- adding queueing or multi-stream local LLM support
- changing ds4's context window unless live server validation proves the current 100k value is wrong

## Proposed Decision

Set ds4 `maxOutputTokens` to `384_000`, reflecting the DeepSeek model
capability. Set explicit `reservedOutputTokens` to `20_000`.

With the current context policy, this means:

```text
contextWindowTokens = 100000
maxOutputTokens = 384000
reservedOutputTokens = 20000
usableInputWindowTokens = 80000
autoCompactionThresholdTokens = floor(80000 * 0.95) = 76000
```

This keeps the context-budget meter useful for long terminal/tool histories
without pretending the model can only emit 80k tokens. The local ds4 server is
still expected to enforce the effective generation limit from the configured
context window and prompt length. The current local context window is 100k, but
the same model may be configured with a much larger context window in the
future.

Tradeoff: the static output reserve is far lower than the request-time maximum
output capability. A request with an 80k prompt cannot also produce a 384k
completion under a 100k context window. This is acceptable as a first-pass
budget policy because ds4 enforces context-window limits locally, but future
dynamic output caps may be needed if ds4 returns context-limit or
incomplete-output failures near the 80k input budget.

If live validation shows the 20k reserve is too small, the next design choice should be explicit:

- increase `reservedOutputTokens` and accept more frequent compaction
- reduce request `maxOutputTokens`
- add a dynamic per-request output cap based on estimated input tokens

Do not silently clamp the context resolver. The model catalog should advertise a coherent policy.

## Design

### Option E: Correct ds4 Metadata

Update ds4 metadata from an invalid 128k default-reserved policy to a 384k
model output capability with a 20k explicit output reserve in:

- service model catalog
- direct ds4 provider defaults
- service config default for `DS4_DIRECT_MAX_OUTPUT_TOKENS`
- daemon CLI/env default for `BUD_LOCAL_LLM_DS4_MAX_OUTPUT_TOKENS`
- daemon local LLM capability examples/tests
- plan/design/env examples

The catalog should remain the source of truth for product-model context policy. Bud-advertised local metadata can narrow the product model cap, but should not widen it beyond the catalog cap in browser-facing model inventory.

### Option D: Generic Model Output Cap Resolution

Change `AgentModelRunner` to derive request caps generically:

```typescript
const capabilities = provider.getModelCapabilities(model);
const maxOutputTokens = Math.min(
  config.agentMaxOutputTokens,
  capabilities.maxOutputTokens,
);
```

Important details:

- use the selected product model when resolving capabilities so catalog-backed product IDs are honored
- preserve provider-specific behavior for hidden provider-model overrides
- keep `AGENT_MAX_OUTPUT_TOKENS` as a global upper bound when explicitly configured, not as context-budget metadata
- do not use `reservedOutputTokens` to cap request-time `maxOutputTokens`
- do not add a ds4-specific branch

This ensures ds4 requests cannot exceed the selected model's advertised output
capability. If the global agent cap remains 128k, requests may still be lower
than the 384k ds4 capability; that should be treated as a service-level request
cap, not model metadata.

### Bud-Local Capability Projection

When projecting Bud-local ds4 metadata into `/api/models?bud_id=...`:

- use the catalog context policy for product-budget fields
- expose `max_output_tokens` as the minimum of daemon-advertised max and product catalog max
- fall back to catalog max when the daemon omits or advertises invalid metadata
- keep raw daemon-local URL and endpoint details hidden

This avoids daemon metadata widening the product cap beyond 384k while still
allowing a daemon to narrow the displayed cap if its local configuration is
lower.

## Implementation Tasks

### Task 1: Update ds4 output metadata

Set ds4 `maxOutputTokens` defaults to `384_000` in:

- `service/src/llm/model-catalog.ts`
- `service/src/llm/providers/ds4.ts`
- `service/src/config.ts`
- `bud/src/config.rs`
- daemon test fixtures that construct `BudArgs`

Set catalog `reservedOutputTokens` to `20_000` for `ds4-deepseek-v4-flash`.

Update docs/spec references from `128000` to `384000` only for ds4-specific
max-output values. Do not change cloud model defaults.

### Task 2: Cap model-runner output requests generically

In `AgentModelRunner.invokeModel(...)`, resolve provider capabilities and use:

```typescript
maxOutputTokens: Math.min(config.agentMaxOutputTokens, capabilities.maxOutputTokens)
```

If capabilities are unavailable or invalid, fall back to the current global default and log a bounded diagnostic.

### Task 3: Normalize Bud-local model projection

Update `listHealthyBudLocalDs4Models(...)` or the route projection so daemon-advertised `max_output_tokens` cannot widen the product cap.

Preferred behavior:

```text
displayed max_output_tokens = min(valid daemon max, catalog max)
```

### Task 4: Update context-budget and model tests

Add or update tests for:

- ds4 catalog context policy is valid
- ds4 usable input window is 80k when max output is 384k and reserved output is 20k
- `/api/models` direct ds4 returns 384k output, 20k reserve, and valid budget fields
- `/api/models?bud_id=...` clamps daemon `max_output_tokens` above 384k down to the catalog cap
- `/api/models?bud_id=...` preserves a lower valid daemon `max_output_tokens` when local configuration narrows the cap
- model runner never requests more than the selected provider/model capability
- OpenAI/Anthropic requests remain capped as expected

### Task 5: Update specs and examples

Update:

- [../../service/src/src.spec.md](../../service/src/src.spec.md)
- [../../service/src/llm/llm.spec.md](../../service/src/llm/llm.spec.md)
- [../../service/src/llm/providers/providers.spec.md](../../service/src/llm/providers/providers.spec.md)
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md)
- [../../bud/src/src.spec.md](../../bud/src/src.spec.md)
- [../../design/local-ds4-llm-over-bud.md](../../design/local-ds4-llm-over-bud.md)
- [implementation-spec.md](./implementation-spec.md)

## Test Plan

- `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/llm/model-catalog.test.ts src/routes/models.test.ts src/agent/model-runner.test.ts`
- `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/llm/providers/providers.test.ts src/llm/index.test.ts`
- `cargo test --manifest-path /Users/adam/bud/bud/Cargo.toml local_llm`
- service build after implementation

## Acceptance Criteria

- ds4 no longer logs `invalid_context_policy` during normal context-budget checks.
- ds4 request bodies use `max_output_tokens <= 384000` when the selected product model is `ds4-deepseek-v4-flash`.
- ds4 context-budget snapshots report `reserved_output_tokens = 20000` and `usable_input_window_tokens = 80000`.
- Cloud model request caps are unchanged except for the generic capability cap behavior.
- Bud daemon metadata advertising more than 384k does not make browser `/api/models` show a wider ds4 output cap.
- The chosen 384k output cap, 20k output reserve, and resulting 80k input budget are documented.

## Implementation Notes

- The service catalog is the source of truth for ds4's 384k max-output capability and 20k reserved-output context policy.
- Direct service-local ds4 and Bud daemon ds4 defaults now advertise 384k max output.
- `AgentModelRunner` caps every provider request to the lower of `AGENT_MAX_OUTPUT_TOKENS` and selected-model/provider capabilities.
- Bud-local `/api/models?bud_id=...` projection clamps daemon-advertised ds4 max output to the product catalog cap while preserving lower daemon values.

## Open Questions

- Is a 20k reserve large enough for normal ds4 final answers and post-tool explanations?
- Should request output caps eventually become dynamic based on estimated input tokens and model context window?
- If the default service-level `AGENT_MAX_OUTPUT_TOKENS` remains 128k, should ds4 requests intentionally stay below the model's 384k capability unless operators opt into a larger cap?
