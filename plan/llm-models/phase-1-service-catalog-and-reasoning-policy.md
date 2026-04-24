# Phase 1: Service Catalog And Reasoning Policy

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented

---

## Objective

Add the service foundation for catalog-backed model resolution and model-specific reasoning validation without depending on UI changes.

By the end of this phase:

- product model metadata lives in one catalog module
- the registry resolves product IDs through the catalog
- reasoning values are represented as a broad model-specific type
- unsupported reasoning values can fail before provider invocation
- service unit tests cover uniqueness, defaults, and policy behavior

## Scope

### In Scope

- `service/src/llm/model-catalog.ts`
- `service/src/llm/reasoning-policy.ts`
- catalog exports from `service/src/llm/index.ts`
- registry changes to resolve catalog product IDs
- `ReasoningLevel` type expansion to `none | minimal | low | medium | high | xhigh | max`
- request-schema acceptance for the broader set
- service tests for catalog and policy behavior
- service LLM/agent/routes spec updates if implementation lands in this phase

### Out Of Scope

- provider request-shape changes
- `/api/models` response contract changes
- web UI adoption
- live provider smoke tests

## Catalog Contract

Create a code catalog with one entry per product-exposed model.

Each entry should include:

- product `id`
- provider key
- provider model string or snapshot
- display name
- family/tier/sort order
- default markers
- capability metadata
- reasoning control metadata

The catalog should not include an `available` flag. Provider registration and API keys determine which provider-backed entries are listable at runtime.

## Initial Entries

| Product ID | Provider | Provider model | Reasoning levels | Default |
| --- | --- | --- | --- | --- |
| `claude-opus-4-6` | Anthropic | `claude-opus-4-6` | `low`, `medium`, `high`, `max` | `high`, global model default |
| `claude-sonnet-4-6` | Anthropic | `claude-sonnet-4-6` | `low`, `medium`, `high`, `max` | `medium` |
| `claude-haiku-4-5` | Anthropic | `claude-haiku-4-5-20251001` | `none`, `low`, `medium`, `high` | `none` |
| `claude-opus-4-7` | Anthropic | `claude-opus-4-7` | `low`, `medium`, `high`, `xhigh`, `max` | `xhigh` |
| `gpt-5.4` | OpenAI | `gpt-5.4-2026-03-05` | `none`, `low`, `medium`, `high`, `xhigh` | `none` |
| `gpt-5.4-mini` | OpenAI | `gpt-5.4-mini-2026-03-17` | `none`, `low`, `medium`, `high`, `xhigh` | `none` |
| `gpt-5.4-nano` | OpenAI | `gpt-5.4-nano-2026-03-17` | `none`, `low`, `medium`, `high`, `xhigh` | `none` |
| `gpt-5.5` | OpenAI | `gpt-5.5` | `none`, `low`, `medium`, `high`, `xhigh` | `none` |

## Implementation Tasks

### Task 1: Add catalog types and entries

Add `service/src/llm/model-catalog.ts` with:

- `ProviderId`
- `ReasoningLevel`
- `ReasoningControl`
- `ModelCatalogEntry`
- catalog constants
- helpers such as `getCatalogEntry`, `listCatalogEntries`, and `getDefaultModelEntry`

Keep the catalog data close to the type definition so future model additions are reviewable as a compact diff.

### Task 2: Add reasoning policy module

Add `service/src/llm/reasoning-policy.ts`.

Responsibilities:

- resolve omitted `reasoning_effort` to the model default
- reject unsupported values with structured details
- return a normalized provider-independent decision object
- leave provider-specific request lowering to provider adapters

Recommended error shape:

```json
{
  "code": "invalid_reasoning_effort",
  "message": "Reasoning effort xhigh is not supported by claude-opus-4-6",
  "supported_values": ["low", "medium", "high", "max"]
}
```

### Task 3: Move registry alias/model ownership onto the catalog

Refactor `service/src/llm/registry.ts` so model lookup resolves product IDs through catalog entries.

The registry should answer:

- provider for product model
- provider model string for invocation
- list of catalog entries backed by configured providers

The registry should not be the long-term home for product display names or aliases.

### Task 4: Broaden request validation

Update `service/src/routes/threads/shared.ts` so `reasoning_effort` accepts:

- `none`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`
- `max`

Do not treat schema acceptance as semantic acceptance. Semantic validation belongs to the reasoning policy after selected model resolution.

### Task 5: Update model-runner reasoning resolution

Update `service/src/agent/model-runner.ts` so selected model and selected effort pass through the catalog reasoning policy before provider invocation.

Keep the first pass focused:

- do not change the tool loop
- do not change stream event shapes
- do not change transcript persistence

### Task 6: Add service tests

Add focused tests for:

- every catalog product ID is unique
- exactly one global default exists
- global default is `claude-opus-4-6`
- catalog entries map to known providers
- GPT-5.5 is present in the OpenAI product list
- Opus 4.6 rejects `xhigh` and accepts `max`
- Opus 4.7 accepts `xhigh`
- GPT-5.4 accepts `none` and `xhigh`
- omitted effort resolves to model default
- unsupported effort returns `invalid_reasoning_effort`

## Validation Checklist

- [x] `service/src/llm/model-catalog.ts` exists
- [x] `service/src/llm/reasoning-policy.ts` exists
- [x] registry resolves product IDs through catalog entries
- [x] `reasoning_effort` schema accepts `xhigh` and `max`
- [x] semantic validation rejects unsupported model/effort combinations
- [x] catalog tests cover uniqueness and defaults
- [x] policy tests cover supported and unsupported efforts

## Exit Criteria

This phase is done when service code can resolve model + reasoning choices through the catalog and fail unsupported combinations before any provider-specific request is built.
