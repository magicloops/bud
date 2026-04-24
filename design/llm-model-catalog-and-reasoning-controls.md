# LLM Model Catalog And Reasoning Controls

> Design sketch for making Bud's model inventory and reasoning controls provider-specific, easy to update, and safe to expose through first-party clients.

## Context

Bud already has a provider abstraction for OpenAI and Anthropic, but model metadata is spread across provider classes, the registry, the models route, request validation, and the web composer. This makes simple model refreshes more invasive than they should be.

Current requested target:

| Provider | Models to expose | Default |
| --- | --- | --- |
| Anthropic | Claude Opus 4.6, Claude Sonnet 4.6, Claude Haiku 4.5, Claude Opus 4.7 | Claude Opus 4.6 |
| OpenAI | GPT-5.4, GPT-5.4 mini, GPT-5.4 nano, GPT-5.5 | Provider-specific default only if selected by the user |

## Current Implementation Review

Relevant specs:

- [service/src/llm/llm.spec.md](../service/src/llm/llm.spec.md)
- [service/src/llm/providers/providers.spec.md](../service/src/llm/providers/providers.spec.md)
- [service/src/agent/agent.spec.md](../service/src/agent/agent.spec.md)
- [service/src/routes/routes.spec.md](../service/src/routes/routes.spec.md)
- [web/src/lib/lib.spec.md](../web/src/lib/lib.spec.md)
- [web/src/routes/$budId/budId.spec.md](../web/src/routes/$budId/budId.spec.md)

Current code shape:

- [service/src/llm/providers/openai.ts](../service/src/llm/providers/openai.ts) owns OpenAI `supportedModels`, context/output limits, and whether a model is a reasoning model.
- [service/src/llm/providers/anthropic.ts](../service/src/llm/providers/anthropic.ts) owns Anthropic `supportedModels`, output limits, and maps Bud reasoning levels to manual `thinking.budget_tokens`.
- [service/src/llm/registry.ts](../service/src/llm/registry.ts) owns aliases as a private constant, resolves aliases to snapshots, and maps registered provider models to providers.
- [service/src/routes/models.ts](../service/src/routes/models.ts) rebuilds public model metadata from registered providers, then hardcodes display names and sorts by provider.
- [service/src/config.ts](../service/src/config.ts) defines the global `ReasoningEffortSetting` as `none | low | medium | high`, sets `DEFAULT_MODEL`, and parses `AGENT_REASONING_EFFORT`.
- [service/src/routes/threads/shared.ts](../service/src/routes/threads/shared.ts) validates `reasoning_effort` with the same global enum.
- [service/src/agent/model-runner.ts](../service/src/agent/model-runner.ts) normalizes reasoning at request time, then turns every non-`none` value into canonical `reasoning: { enabled: true, effort }`.
- [web/src/lib/models.ts](../web/src/lib/models.ts) fetches `/api/models`, prefers aliases, and selects `default_model` or the first model.
- [web/src/components/workbench/command-composer.tsx](../web/src/components/workbench/command-composer.tsx), [web/src/routes/$budId/new.tsx](../web/src/routes/$budId/new.tsx), and [web/src/routes/$budId/$threadId.tsx](../web/src/routes/$budId/$threadId.tsx) hardcode the same global reasoning options.

Main gaps:

1. Model data is not centralized. Adding a model requires editing provider classes, aliases, display names, default env examples, docs, and often tests.
2. `ModelCapabilities` only exposes booleans for reasoning/thinking. It does not tell clients which reasoning controls are valid for the selected model.
3. Request validation is too global. A future valid model-specific value such as `xhigh` or `max` is rejected before provider policy can decide whether it applies.
4. Anthropic reasoning has moved beyond manual `budget_tokens`. Newer Claude models use provider `effort` plus adaptive thinking, while older Claude models still use manual thinking budgets.
5. GPT-5.5 API readiness is a product launch assumption for this implementation. OpenAI docs reviewed on April 23, 2026 still describe GPT-5.5 API availability as coming soon, but Bud should treat `gpt-5.5` as live for this rollout and validate it in smoke tests rather than introducing an unavailable-model state.

## Verified Provider Notes

OpenAI:

- The GPT-5.4 API model page lists `gpt-5.4` with snapshot `gpt-5.4-2026-03-05`, a 1,050,000 context window, 128,000 max output tokens, Responses API support, streaming, function calling, and structured outputs. It states `reasoning.effort` supports `none` default, `low`, `medium`, `high`, and `xhigh`.
- GPT-5.4 mini and nano API pages list aliases/snapshots `gpt-5.4-mini` -> `gpt-5.4-mini-2026-03-17` and `gpt-5.4-nano` -> `gpt-5.4-nano-2026-03-17`, both with 400,000 context windows and 128,000 max output tokens. The OpenAI models index lists the GPT-5.4 family reasoning values as `none`, `low`, `medium`, `high`, and `xhigh`, so Bud should expose the full set for GPT-5.4, GPT-5.4 mini, and GPT-5.4 nano.
- The reasoning guide says supported effort values are model-dependent and can include `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`; defaults are also model-dependent.
- GPT-5.5 is announced by OpenAI on April 23, 2026. Bud will treat it as a live API model for this rollout based on the launch timing decision, with smoke validation required before handoff.

Anthropic:

- Current Claude model overview lists Claude API IDs/aliases for Opus 4.7 (`claude-opus-4-7`), Sonnet 4.6 (`claude-sonnet-4-6`), and Haiku 4.5 (`claude-haiku-4-5-20251001`, alias `claude-haiku-4-5`).
- Opus 4.6 announcement gives the Claude API ID `claude-opus-4-6`.
- Anthropic effort docs say `output_config.effort` is supported on Opus 4.7, Opus 4.6, Sonnet 4.6, Opus 4.5, and Claude Mythos Preview.
- Effort values are provider/model-specific: Opus 4.6 and Sonnet 4.6 support `low`, `medium`, `high` default, and `max`; Opus 4.7 additionally supports `xhigh` between `high` and `max`.
- Adaptive thinking is recommended on Opus 4.7, Opus 4.6, and Sonnet 4.6. On Opus 4.7 it is the only supported thinking mode; manual `thinking: { type: "enabled", budget_tokens }` is rejected.
- Haiku 4.5 supports extended thinking but not adaptive thinking or the effort parameter in current docs. It should keep manual thinking-budget mapping unless we choose to hide reasoning controls for Haiku.

Sources:

- OpenAI GPT-5.4 model page: https://developers.openai.com/api/docs/models/gpt-5.4
- OpenAI GPT-5.4 mini model page: https://developers.openai.com/api/docs/models/gpt-5.4-mini
- OpenAI GPT-5.4 nano model page: https://developers.openai.com/api/docs/models/gpt-5.4-nano
- OpenAI models index: https://developers.openai.com/api/docs/models
- OpenAI reasoning guide: https://developers.openai.com/api/docs/guides/reasoning
- OpenAI GPT-5.5 announcement: https://openai.com/index/introducing-gpt-5-5/
- Anthropic models overview: https://platform.claude.com/docs/en/about-claude/models/overview
- Anthropic effort docs: https://platform.claude.com/docs/en/build-with-claude/effort
- Anthropic adaptive thinking docs: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- Anthropic Opus 4.6 announcement: https://www.anthropic.com/news/claude-opus-4-6
- Anthropic Opus 4.7 announcement: https://www.anthropic.com/news/claude-opus-4-7
- Anthropic Haiku 4.5 announcement: https://www.anthropic.com/news/claude-haiku-4-5

## Proposed Design

Introduce one service-owned model catalog that describes every product-exposed model, including aliases, provider IDs, reasoning controls, display order, and defaults.

### Catalog Shape

Create `service/src/llm/model-catalog.ts`:

```typescript
export type ProviderId = "anthropic" | "openai";

export type ReasoningLevel =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ReasoningControl =
  | {
      kind: "openai_reasoning_effort";
      levels: ReasoningLevel[];
      defaultLevel: ReasoningLevel;
      requestField: "reasoning.effort";
    }
  | {
      kind: "anthropic_output_effort";
      levels: ReasoningLevel[];
      defaultLevel: ReasoningLevel;
      requestField: "output_config.effort";
      thinking: "adaptive";
      thinkingDisplay?: "summarized" | "omitted";
    }
  | {
      kind: "anthropic_thinking_budget";
      levels: ReasoningLevel[];
      defaultLevel: ReasoningLevel;
      budgets: Partial<Record<ReasoningLevel, number>>;
      thinking: "manual";
    }
  | {
      kind: "none";
      levels: ["none"];
      defaultLevel: "none";
    };

export type ModelCatalogEntry = {
  id: string;                 // Product-facing alias, e.g. "claude-opus-4-6"
  provider: ProviderId;
  providerModel: string;      // Actual API model string or pinned snapshot
  displayName: string;
  family: "claude" | "gpt";
  tier: "frontier" | "balanced" | "fast";
  sortOrder: number;
  defaultForProvider?: boolean;
  globalDefault?: boolean;
  capabilities: {
    vision: boolean;
    tools: boolean;
    streaming: boolean;
    structuredOutputs: boolean;
    contextWindowTokens: number;
    maxOutputTokens: number;
  };
  reasoning: ReasoningControl;
};
```

The catalog should be code, not database rows, for this pass. These are deploy-time product decisions, and we do not currently need admin-editable model inventory. A future database-backed override can layer on top of this code catalog.

### Initial Catalog Entries

Recommended first pass:

| Product ID | Provider model | Reasoning control | Role |
| --- | --- | --- | --- |
| `claude-opus-4-6` | `claude-opus-4-6` | Anthropic effort: `low`, `medium`, `high`, `max`; default `high` | global default |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | Anthropic effort: `low`, `medium`, `high`, `max`; default `medium` for Bud UI | product model |
| `claude-haiku-4-5` | `claude-haiku-4-5-20251001` | Manual thinking-budget mapping or `none` only; decision needed | product model |
| `claude-opus-4-7` | `claude-opus-4-7` | Anthropic effort: `low`, `medium`, `high`, `xhigh`, `max`; default `xhigh` for model default, but not global default | product model |
| `gpt-5.4` | `gpt-5.4-2026-03-05` | OpenAI effort: `none`, `low`, `medium`, `high`, `xhigh`; default `none` | product model |
| `gpt-5.4-mini` | `gpt-5.4-mini-2026-03-17` | OpenAI effort: `none`, `low`, `medium`, `high`, `xhigh`; default `none` | product model |
| `gpt-5.4-nano` | `gpt-5.4-nano-2026-03-17` | OpenAI effort: `none`, `low`, `medium`, `high`, `xhigh`; default `none` | product model |
| `gpt-5.5` | `gpt-5.5` | OpenAI effort: `none`, `low`, `medium`, `high`, `xhigh`; default `none` unless final API docs require otherwise | product model |

### Registry And Providers

Refactor `ProviderRegistry` so it no longer owns model aliases. It should resolve through the catalog:

- `getCatalogEntry(modelId)`
- `resolveModel(modelId)` returns `{ entry, provider, providerModel }`
- `listModels()` returns catalog entries filtered by registered provider key

Provider classes should still know provider-specific request mechanics, but not the product catalog. Their `supportedModels` can be derived from catalog provider IDs at registration time, or changed to `supportsModel(model)` only.

The Anthropic adapter work should include a package update from the currently installed `@anthropic-ai/sdk` `^0.71.2`. After the bump, verify that `output_config` and `thinking.display` are typed and forwarded by the SDK. If the API is available before SDK typings catch up, isolate any temporary casts in the Anthropic provider adapter rather than leaking provider-specific `any` values into the catalog or policy modules.

### Reasoning Request Flow

Keep the browser payload as `reasoning_effort` for now, but change its validation from a hardcoded enum to a broad string enum:

```typescript
const ReasoningLevelSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
```

Then validate against the selected model after model resolution:

1. Resolve requested `model` to a catalog entry.
2. Resolve requested `reasoning_effort`:
   - if omitted, use entry `reasoning.defaultLevel`
   - if provided and included in entry levels, use it
   - if provided and unsupported, return `400 invalid_reasoning_effort` with supported values
3. Convert the catalog-level control into provider config.

This should move out of `config.ts` and into a small policy module, for example `service/src/llm/reasoning-policy.ts`.

### Provider-Specific Lowering

OpenAI:

- `none` means omit or disable `reasoning` according to the selected model's API requirements.
- `low | medium | high | xhigh` maps to `reasoning.effort`.
- `minimal` remains possible for older GPT-5/o-series entries if we keep them in the catalog later, but is not listed for GPT-5.4 entries.
- Keep `reasoning.summary = "auto"` unless we decide to expose summary verbosity separately.

Anthropic Opus 4.7:

- Use `thinking: { type: "adaptive", display: "omitted" }`.
- Use `output_config: { effort }`.
- Valid efforts: `low`, `medium`, `high`, `xhigh`, `max`.
- Do not send manual `budget_tokens`.

Anthropic Opus 4.6 / Sonnet 4.6:

- Use `thinking: { type: "adaptive", display: "summarized" }`.
- Use `output_config: { effort }`.
- Valid efforts: `low`, `medium`, `high`, `max`.
- Do not keep the old manual budget mapping for these models except behind a compatibility fallback.

Anthropic Haiku 4.5:

- Current docs show extended thinking yes, adaptive thinking no, and no effort support.
- Expose `none`, `low`, `medium`, and `high`; map non-`none` values to manual thinking budgets.

## API Contract

Extend `GET /api/models` so clients do not hardcode controls:

```json
{
  "models": [
    {
      "id": "claude-opus-4-7",
      "provider": "anthropic",
      "provider_model": "claude-opus-4-7",
      "display_name": "Claude Opus 4.7",
      "is_default": false,
      "capabilities": {
        "vision": true,
        "tools": true,
        "streaming": true,
        "structured_outputs": false,
        "context_window_tokens": 1000000,
        "max_output_tokens": 128000
      },
      "reasoning": {
        "kind": "anthropic_output_effort",
        "levels": [
          { "value": "low", "label": "Low" },
          { "value": "medium", "label": "Medium" },
          { "value": "high", "label": "High" },
          { "value": "xhigh", "label": "Extra high" },
          { "value": "max", "label": "Max" }
        ],
        "default_level": "xhigh"
      }
    }
  ],
  "default_model": "claude-opus-4-6"
}
```

Keep `is_alias` / `alias_target` only if we still expose both aliases and snapshots. The preferred path is to expose product IDs only and carry `provider_model` as metadata.

## Web UI

Change `useAvailableModels()` and `CommandComposer` so reasoning options are derived from the selected model:

- `ModelInfo.reasoning.levels` drives the dropdown.
- On model change, if the current reasoning level is unsupported, reset to that model's `default_level`.
- Hide or disable the reasoning dropdown when `levels` is only `none`.
- Preserve the request field as `reasoning_effort` so mobile/web clients share one simple user-facing contract.
- Mobile does not need a compatibility window for the new `xhigh` or `max` values. `/api/models` should be treated as the compatibility boundary for first-party clients.

Labels should be API-provided or locally mapped from the API values:

| Value | Suggested label |
| --- | --- |
| `none` | Fast |
| `minimal` | Minimal |
| `low` | Low |
| `medium` | Medium |
| `high` | High |
| `xhigh` | Extra |
| `max` | Max |

## Rollout Plan

1. Add catalog and policy modules.
   - Add `service/src/llm/model-catalog.ts`.
   - Add `service/src/llm/reasoning-policy.ts`.
   - Unit test model resolution, provider registration filtering, defaults, and unsupported effort errors.

2. Move model listing onto the catalog.
   - Refactor `ProviderRegistry` alias handling.
   - Refactor `/api/models` to emit catalog-backed metadata and provider-specific reasoning controls.
   - Keep response fields backward-compatible where reasonable.

3. Update provider adapters.
   - OpenAI: add GPT-5.4 entries and xhigh support in canonical config.
   - Anthropic: add Opus 4.6, Sonnet 4.6, Haiku 4.5, Opus 4.7 entries; switch Opus 4.6/Sonnet 4.6/Opus 4.7 to `output_config.effort` and adaptive thinking.
   - Upgrade `@anthropic-ai/sdk`, then verify typed support for `output_config` and `thinking.display`.
   - Keep old models out of the product list unless needed for hidden fallback tests.

4. Update request validation and agent runner.
   - Accept broad `ReasoningLevel`.
   - Resolve selected model and reasoning through the new policy.
   - Return a clear 400 for unsupported model/effort combinations before starting the agent turn.

5. Update web composer.
   - Use per-model reasoning metadata.
   - Reset unsupported reasoning values on model changes.
   - Add tests for option derivation if we extract a pure helper.

6. Documentation and specs.
   - Update `service/src/llm/llm.spec.md`.
   - Update `service/src/llm/providers/providers.spec.md`.
   - Update `service/src/agent/agent.spec.md`.
   - Update `service/src/routes/routes.spec.md`.
   - Update `web/src/lib/lib.spec.md`.
   - Update `web/src/routes/$budId/budId.spec.md`.
   - Update `service/.env.example` and `service/README.md` default model references.

## Testing Plan

Service:

- Catalog unit tests:
  - all product IDs are unique
  - every catalog model has a registered provider when its API key is configured
  - exactly one global default exists and it resolves when Anthropic is configured
  - GPT-5.5 is included in the OpenAI product list
- Reasoning policy tests:
  - Opus 4.6 rejects `xhigh` and accepts `max`
  - Opus 4.7 accepts `xhigh`
  - GPT-5.4 accepts `none` and `xhigh`
  - Haiku 4.5 follows whichever decision we make
- Provider request-shape tests:
  - Opus 4.7 sends adaptive thinking and `output_config.effort`, not manual `budget_tokens`
  - Opus 4.6/Sonnet 4.6 send adaptive thinking and effort
  - GPT-5.4 sends `reasoning.effort` only when not `none`
- Route tests:
  - `/api/models` returns per-model reasoning controls
  - message creation returns 400 for unsupported effort before persisting/starting a turn if model validation moves early enough

Web:

- Pure helper tests for selected-model reasoning options.
- Manual validation that changing models changes the reasoning dropdown and resets unsupported values.

Manual/API validation:

- Smoke one turn on each enabled provider family with tool calls.
- Smoke Opus 4.7 with `xhigh`.
- Smoke Opus 4.6 with `max`.
- Smoke GPT-5.4 with `xhigh`.
- Smoke GPT-5.5 before handoff because current docs lag the launch decision.

## Resolved Decisions

1. GPT-5.5 exposure:
   - Treat `gpt-5.5` as live in the catalog and `/api/models`. Do not add an `available` boolean for public or admin/debug clients in this pass.

2. Anthropic global default:
   - Requested default is Opus 4.6. Recommended `DEFAULT_MODEL=claude-opus-4-6`.

3. Opus 4.7 default effort:
   - API default is `high`; Anthropic recommends starting with `xhigh` for coding/agentic work. Recommended Bud model default: `xhigh` for Opus 4.7, while keeping global default model at Opus 4.6.

4. Sonnet 4.6 default effort:
   - API default is `high`; Anthropic docs recommend explicitly setting `medium` for most applications to avoid unexpected latency. Recommended Bud model default: `medium`.

5. GPT-5.4 mini and nano reasoning:
   - Expose `none`, `low`, `medium`, `high`, and `xhigh`, with `none` as the default, matching the OpenAI models index.

6. Anthropic SDK:
   - Upgrade the Anthropic TypeScript SDK as part of implementation, then verify native typed support for the new Claude request fields before falling back to temporary local casts.

7. Mobile compatibility:
   - No compatibility window is needed for `xhigh` or `max`; mobile is still in development and can adopt the per-model `/api/models` contract directly.

## Remaining Decisions

No product-model decisions remain open for this implementation. Live smoke tests still need to verify provider account access and API behavior for GPT-5.5 and the new Claude models before mobile handoff.

## Acceptance Criteria

- Adding a future model is usually one catalog entry plus provider-specific lowering only if the provider API changed.
- `/api/models` is the source of truth for first-party UI controls.
- Unsupported model/reasoning combinations fail with clear 400 errors.
- Anthropic Opus 4.7 does not use deprecated manual thinking budgets.
- GPT-5.5 is exposed as runnable and validated with an OpenAI smoke test before handoff.
- Specs are updated with the new catalog ownership and per-model reasoning contract.
