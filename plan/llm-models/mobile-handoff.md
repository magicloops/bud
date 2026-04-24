# Mobile Handoff: LLM Model Catalog And Reasoning

## Summary

Mobile should treat `GET /api/models` as the source of truth for model selection and reasoning controls. There is no compatibility window for old hardcoded reasoning values because the app is still in development.

## Contract

Each model entry includes:

- `id`: product model ID to send as `model`
- `provider`
- `provider_model`: provider API model for debug/display only
- `display_name`
- `is_default`
- `capabilities`
- `reasoning.kind`
- `reasoning.levels`: allowed `reasoning_effort` values and labels
- `reasoning.default_level`: value to use when the user has not selected an effort

Message sends should include:

```json
{
  "text": "User request",
  "client_id": "uuidv7",
  "model": "claude-opus-4-6",
  "reasoning_effort": "high"
}
```

If the model list has not loaded, omit both `model` and `reasoning_effort`; the service will use the server default model and that model's default reasoning level.

## Client Rules

- Do not hardcode the reasoning list globally.
- On model change, keep the current reasoning value only if it exists in the new model's `reasoning.levels`.
- If the current value is unsupported, reset to `reasoning.default_level`.
- Hide or disable reasoning controls only when the model exposes a single `none` level.
- Handle `400 invalid_reasoning_effort` by refetching `/api/models` and resetting the selector to the model default.

## Current Product Models

| Model | Default Reasoning | Levels |
| --- | --- | --- |
| `claude-opus-4-6` | `high` | `low`, `medium`, `high`, `max` |
| `claude-sonnet-4-6` | `medium` | `low`, `medium`, `high`, `max` |
| `claude-haiku-4-5` | `none` | `none`, `low`, `medium`, `high` |
| `claude-opus-4-7` | `xhigh` | `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-5.4` | `none` | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4-mini` | `none` | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4-nano` | `none` | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.5` | `none` | `none`, `low`, `medium`, `high`, `xhigh` |
