# Phase 3: API Contract And Client Adoption

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented

---

## Objective

Make `/api/models` the first-party client source of truth and update the reference web client to derive reasoning controls from the selected model.

By the end of this phase:

- `/api/models` is catalog-backed
- model responses include provider/model-specific reasoning metadata
- web no longer hardcodes the global four-value reasoning selector
- unsupported reasoning values reset on model change
- mobile handoff expectations are explicit

## Scope

### In Scope

- `service/src/routes/models.ts`
- route tests for `/api/models`
- message-create error behavior for unsupported reasoning choices
- `web/src/lib/models.ts`
- `web/src/components/workbench/command-composer.tsx`
- `web/src/routes/$budId/new.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- web type updates for model reasoning metadata
- mobile-facing notes in the final handoff phase

### Out Of Scope

- mobile repo implementation
- admin/debug unavailable model views
- reasoning summary UI
- provider live smoke tests

## API Contract Direction

`GET /api/models` should return product models only.

Example shape:

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

Do not add:

- `available`
- hidden/unavailable GPT-5.5 entries
- duplicate snapshot rows as selectable models

Keep `provider_model` as metadata for diagnostics and developer clarity.

## Error Contract Direction

When a client sends a reasoning value unsupported by the selected model:

- return `400`
- do not start the agent turn
- include the selected model and supported values
- avoid persisting partial assistant/tool output

Preferred code:

- `invalid_reasoning_effort`

## Web UI Direction

The web composer should derive controls from `ModelInfo.reasoning`.

Behavior:

- selected model drives available reasoning values
- omitted or unsupported current value resets to selected model `default_level`
- if only `none` is available, hide or disable the reasoning dropdown
- labels come from API if present, otherwise a local value-to-label helper
- request payload remains `reasoning_effort`

Suggested labels:

| Value | Label |
| --- | --- |
| `none` | Fast |
| `minimal` | Minimal |
| `low` | Low |
| `medium` | Medium |
| `high` | High |
| `xhigh` | Extra |
| `max` | Max |

## Implementation Tasks

### Task 1: Refactor `/api/models`

Update `service/src/routes/models.ts` so it:

- reads from catalog/registry instead of rebuilding metadata from providers
- returns product IDs in stable sort order
- returns `default_model`
- emits reasoning metadata per model
- omits provider entries whose provider is not configured
- preserves compatibility fields only when still meaningful

### Task 2: Add route tests

Cover:

- Anthropic-only configured returns Anthropic product models
- OpenAI-only configured returns OpenAI product models
- both configured returns both model families
- default model is `claude-opus-4-6` when Anthropic is configured
- GPT-5.5 appears in OpenAI model list
- Opus 4.7 includes `xhigh` and `max`
- Opus 4.6 includes `max` but not `xhigh`
- GPT-5.4 mini/nano include `xhigh`

### Task 3: Wire unsupported-effort errors into message creation

Ensure the semantic policy error reaches `POST /api/threads/:thread_id/messages` as a clear `400`.

The validation point should happen after:

- request body parse
- authenticated/authorized thread resolution
- model resolution

The validation point should happen before:

- agent turn start
- provider invocation

### Task 4: Update web model types and loader helper

Update `web/src/lib/models.ts` to represent:

- `provider_model`
- `display_name`
- `capabilities`
- `reasoning.kind`
- `reasoning.levels`
- `reasoning.default_level`

Keep one helper responsible for:

- choosing the default model
- looking up selected model
- returning reasoning levels for selected model
- normalizing invalid selected reasoning values

### Task 5: Update command composer and route state

Update composer usage in:

- `web/src/components/workbench/command-composer.tsx`
- `web/src/routes/$budId/new.tsx`
- `web/src/routes/$budId/$threadId.tsx`

Ensure:

- model changes reset invalid reasoning values
- initial state uses model default
- submitted payload still uses `reasoning_effort`
- text fits existing compact selector UI with `xhigh` and `max`

### Task 6: Add web helper tests if practical

If model/reasoning normalization is extracted as a pure helper, test:

- preserving supported current value
- resetting unsupported value to model default
- hiding/disabling control when only `none` is available
- defaulting cleanly when `/api/models` returns no configured providers

## Validation Checklist

- [x] `/api/models` is catalog-backed
- [x] `/api/models` includes per-model reasoning metadata
- [x] `/api/models` does not include an `available` field
- [x] GPT-5.5 appears when OpenAI provider is configured
- [x] unsupported effort returns 400 before turn start
- [x] web derives reasoning options from selected model
- [x] web resets unsupported effort on model change
- [x] web still submits `reasoning_effort`
- [x] mobile handoff can point to `/api/models` without extra compatibility rules

## Exit Criteria

This phase is done when the service and reference web client both treat `/api/models` as the source of truth for model selection and reasoning controls.
