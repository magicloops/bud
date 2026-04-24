# Phase 2: Provider Adapters And Model Rollout

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented; live smoke validation deferred

---

## Objective

Update OpenAI and Anthropic adapters so the new product models can be invoked with provider-correct reasoning request shapes.

By the end of this phase:

- OpenAI provider supports GPT-5.4, GPT-5.4 mini, GPT-5.4 nano, and GPT-5.5
- Anthropic provider supports Opus 4.6, Sonnet 4.6, Haiku 4.5, and Opus 4.7
- Anthropic SDK is upgraded
- Claude 4.6/4.7 effort models use `output_config.effort`
- Opus 4.7 does not use manual thinking budgets
- request-shape tests cover the new provider behavior

## Scope

### In Scope

- `service/package.json` and `service/pnpm-lock.yaml` Anthropic SDK update
- `service/src/llm/providers/openai.ts`
- `service/src/llm/providers/anthropic.ts`
- provider capabilities for the new model set
- OpenAI reasoning lowering for `none | low | medium | high | xhigh`
- Anthropic output effort lowering for Opus 4.6, Sonnet 4.6, and Opus 4.7
- Haiku 4.5 manual thinking-budget behavior
- provider request-shape tests

### Out Of Scope

- `/api/models` response change
- web UI changes
- live provider smoke tests outside local/manual validation

## Resolved Pre-Implementation Gates

1. Haiku 4.5:
   - uses manual budget mapping for `low`, `medium`, and `high`; `none` disables thinking

2. Claude thinking display:
   - Opus 4.6 and Sonnet 4.6 use `summarized`
   - Opus 4.7 uses `omitted`

3. Old model compatibility:
   - removed from first-party `/api/models`
   - tolerated as hidden provider/registry compatibility for explicit old model IDs

## OpenAI Adapter Direction

Update supported product/provider models:

- `gpt-5.4`
- `gpt-5.4-2026-03-05`
- `gpt-5.4-mini`
- `gpt-5.4-mini-2026-03-17`
- `gpt-5.4-nano`
- `gpt-5.4-nano-2026-03-17`
- `gpt-5.5`

Reasoning lowering:

- `none`: omit provider reasoning effort unless the API requires an explicit disable shape
- `low | medium | high | xhigh`: send `reasoning.effort`
- keep `reasoning.summary = "auto"` unless a separate display decision changes this
- do not list `minimal` for GPT-5.4/GPT-5.5 catalog entries

## Anthropic Adapter Direction

Upgrade `@anthropic-ai/sdk` from the current `^0.71.2`.

After the bump:

- verify typings for `output_config`
- verify typings for `thinking.display`
- isolate any temporary casts inside `service/src/llm/providers/anthropic.ts`
- do not leak provider-specific `any` shapes into catalog or policy modules

Model behavior:

| Model | Thinking mode | Effort values | Notes |
| --- | --- | --- | --- |
| `claude-opus-4-6` | adaptive | `low`, `medium`, `high`, `max` | default `high` |
| `claude-sonnet-4-6` | adaptive | `low`, `medium`, `high`, `max` | default `medium` |
| `claude-opus-4-7` | adaptive only | `low`, `medium`, `high`, `xhigh`, `max` | no manual budgets |
| `claude-haiku-4-5-20251001` | manual | `none`, `low`, `medium`, `high` | non-`none` maps to budget tokens |

Anthropic request shape for adaptive-thinking models:

```json
{
  "thinking": {
    "type": "adaptive",
    "display": "omitted"
  },
  "output_config": {
    "effort": "xhigh"
  }
}
```

Opus 4.6 and Sonnet 4.6 use the same adaptive shape with `display: "summarized"`.

## Implementation Tasks

### Task 1: Upgrade Anthropic SDK

Run the package update from `service/`.

After the update:

- inspect generated lockfile changes
- run TypeScript build once code changes are ready
- record any required casts in the phase notes or final handoff

### Task 2: Update OpenAI supported models and capabilities

Move model list ownership toward catalog-backed provider strings.

Ensure capabilities match catalog expectations:

- GPT-5.4 context window: 1,050,000
- GPT-5.4 mini/nano context window: 400,000
- max output tokens: 128,000 for the GPT-5.4 product family
- tools, streaming, structured outputs enabled

### Task 3: Update OpenAI reasoning request lowering

Change OpenAI provider config handling so `xhigh` is valid where catalog policy allowed it.

Add tests that inspect provider request params for:

- `none` omits/disables reasoning effort
- `xhigh` sends the expected effort value
- unsupported values cannot reach provider lowering through normal policy

### Task 4: Update Anthropic supported models and capabilities

Replace current Claude 4.5 product-list assumptions with the new product target.

Capabilities should reflect:

- tool support
- streaming support
- vision support if current adapter supports it
- provider-specific max output/context values from current docs where known
- thinking/effort support per catalog entry

### Task 5: Update Anthropic reasoning request lowering

For Opus 4.6, Sonnet 4.6, and Opus 4.7:

- send adaptive thinking
- send `output_config.effort`
- do not send manual `budget_tokens`
- include Opus 4.7 `xhigh`
- include Opus/Sonnet 4.6 `max`

For Haiku 4.5:

- map non-`none` efforts to manual thinking budgets
- cover the decision in tests

### Task 6: Add provider request-shape tests

Add or update tests so failures are caught without requiring live API calls:

- Opus 4.7 sends adaptive thinking plus `output_config.effort = "xhigh"`
- Opus 4.7 does not send `budget_tokens`
- Opus 4.6 accepts `max`
- Sonnet 4.6 uses configured default when effort omitted
- GPT-5.4 sends `reasoning.effort = "xhigh"` when selected
- GPT-5.4 `none` does not send an unwanted high-reasoning default
- GPT-5.5 routes through OpenAI provider

## Validation Checklist

- [x] Anthropic SDK is upgraded
- [x] SDK support for `output_config` is verified or casts are isolated
- [x] OpenAI provider recognizes GPT-5.4 family and GPT-5.5
- [x] Anthropic provider recognizes Opus 4.6, Sonnet 4.6, Haiku 4.5, and Opus 4.7
- [x] Opus 4.7 request shape uses adaptive thinking and output effort
- [x] Opus 4.7 request shape never sends manual budget tokens
- [x] GPT-5.4 `xhigh` request shape is covered by tests
- [x] Haiku 4.5 behavior matches the selected decision

## Exit Criteria

This phase is done when provider adapters can build correct request params for every target product model and automated request-shape tests cover the new reasoning behavior.
