# iOS LLM Models Backend Handoff

**Status:** Ready for iOS implementation  
**Audience:** iOS, backend, web platform, product  
**Last Updated:** 2026-04-24

## Purpose

Bud's model picker and reasoning controls are now catalog-backed on the service. iOS should stop hardcoding the model list or a global reasoning list and instead use `GET /api/models` as the source of truth.

This handoff covers:

- how to fetch available models
- how to render model-specific reasoning controls
- what to send on chat message creation
- how to handle stale saved selections and backend validation errors

## Backend Status

Implemented in this branch:

- service-owned LLM model catalog
- catalog-backed `GET /api/models`
- model-specific `reasoning_effort` validation on message send
- web composer updated to consume the same endpoint
- new Anthropic and OpenAI product models
- no compatibility window for the old four-value reasoning list

Validation already run:

```text
pnpm --dir service test
pnpm --dir service build
pnpm --dir service lint
pnpm --dir web build
pnpm --dir web lint
git diff --check
```

Live provider smoke tests were not run in this branch because they require real provider credentials and account model access.

## Route: List Models

Use the same authenticated transport as the rest of the mobile API.

```http
GET /api/models
```

Auth behavior:

- `401` if unauthenticated.
- Response is scoped to configured providers, not user-owned data.
- If no provider credentials are configured, `models` is empty and `default_model` is `null`.

Response shape:

```json
{
  "models": [
    {
      "id": "claude-opus-4-6",
      "provider": "anthropic",
      "provider_model": "claude-opus-4-6",
      "display_name": "Claude Opus 4.6",
      "is_default": true,
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
          { "value": "max", "label": "Max" }
        ],
        "default_level": "high"
      }
    }
  ],
  "default_model": "claude-opus-4-6"
}
```

Important field rules:

- Send `id` back as the chat request `model`.
- Treat `provider_model` as debug/display metadata only. Do not send it as the normal product selection.
- Use `display_name` for picker labels.
- Use server order as display order.
- Use `is_default` or top-level `default_model` for initial selection. Prefer `default_model` when present and present in `models`.
- Do not expect an `available` boolean. Configured catalog entries are treated as live.
- Do not hardcode reasoning levels globally. Use each model's `reasoning.levels`.

## Current Product Models

When both Anthropic and OpenAI providers are configured, the endpoint returns:

| Product ID | Display | Provider | Provider Model | Default Reasoning | Levels |
| --- | --- | --- | --- | --- | --- |
| `claude-opus-4-6` | Claude Opus 4.6 | `anthropic` | `claude-opus-4-6` | `high` | `low`, `medium`, `high`, `max` |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | `anthropic` | `claude-sonnet-4-6` | `medium` | `low`, `medium`, `high`, `max` |
| `claude-haiku-4-5` | Claude Haiku 4.5 | `anthropic` | `claude-haiku-4-5-20251001` | `none` | `none`, `low`, `medium`, `high` |
| `claude-opus-4-7` | Claude Opus 4.7 | `anthropic` | `claude-opus-4-7` | `xhigh` | `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-5.4` | GPT-5.4 | `openai` | `gpt-5.4-2026-03-05` | `none` | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4-mini` | GPT-5.4 Mini | `openai` | `gpt-5.4-mini-2026-03-17` | `none` | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4-nano` | GPT-5.4 Nano | `openai` | `gpt-5.4-nano-2026-03-17` | `none` | `none`, `low`, `medium`, `high`, `xhigh` |
| `gpt-5.5` | GPT-5.5 | `openai` | `gpt-5.5` | `none` | `none`, `low`, `medium`, `high`, `xhigh` |

Default behavior:

- Global default with both providers: `claude-opus-4-6`.
- Anthropic-only default: `claude-opus-4-6`.
- OpenAI-only default: `gpt-5.4`.
- No providers: `default_model: null`.

## Suggested iOS DTOs

Keep values string-backed so future models/reasoning levels do not require a binary update.

```swift
struct LLMModelsResponse: Decodable {
    let models: [LLMModel]
    let defaultModel: String?

    enum CodingKeys: String, CodingKey {
        case models
        case defaultModel = "default_model"
    }
}

struct LLMModel: Decodable, Identifiable {
    let id: String
    let provider: String
    let providerModel: String
    let displayName: String
    let isDefault: Bool
    let capabilities: LLMModelCapabilities
    let reasoning: LLMReasoningMetadata

    enum CodingKeys: String, CodingKey {
        case id
        case provider
        case providerModel = "provider_model"
        case displayName = "display_name"
        case isDefault = "is_default"
        case capabilities
        case reasoning
    }
}

struct LLMModelCapabilities: Decodable {
    let vision: Bool
    let tools: Bool
    let streaming: Bool
    let structuredOutputs: Bool
    let contextWindowTokens: Int
    let maxOutputTokens: Int

    enum CodingKeys: String, CodingKey {
        case vision
        case tools
        case streaming
        case structuredOutputs = "structured_outputs"
        case contextWindowTokens = "context_window_tokens"
        case maxOutputTokens = "max_output_tokens"
    }
}

struct LLMReasoningMetadata: Decodable {
    let kind: String
    let levels: [LLMReasoningOption]
    let defaultLevel: String

    enum CodingKeys: String, CodingKey {
        case kind
        case levels
        case defaultLevel = "default_level"
    }
}

struct LLMReasoningOption: Decodable, Identifiable {
    let value: String
    let label: String

    var id: String { value }
}
```

## Selection Rules

On model list load:

1. If a saved model id exists and appears in `models`, keep it.
2. Otherwise use top-level `default_model` when present and valid.
3. Otherwise use the first model in `models`.
4. If `models` is empty, disable model/reasoning controls and send messages without `model` or `reasoning_effort`.

On reasoning load:

1. For the selected model, read `model.reasoning.levels`.
2. If a saved reasoning value appears in that array, keep it.
3. Otherwise use `model.reasoning.default_level`.
4. Hide or disable the reasoning control only when the selected model exposes a single level whose value is `none`.

On model change:

1. Set the new selected model id.
2. Keep the current reasoning value only if the new model supports it.
3. Otherwise reset to the new model's `reasoning.default_level`.

Do not assume:

- every model supports `none`
- every model supports `xhigh`
- every Anthropic model supports `max`
- every model has the same default reasoning level

## Message Send Contract

Existing route:

```http
POST /api/threads/:thread_id/messages
```

Request body fields relevant to this handoff:

```json
{
  "text": "Investigate the failing build",
  "client_id": "0196f0f2-0f4f-7c0f-8b5b-70eb50e1f55c",
  "model": "claude-opus-4-6",
  "reasoning_effort": "high"
}
```

Rules:

- `model` is optional.
- `reasoning_effort` is optional.
- If `/api/models` has loaded and the user has a selected model, send both `model` and a valid `reasoning_effort`.
- If `/api/models` has not loaded, omit both fields and let the service choose `default_model` and its default reasoning.
- `client_id` remains the existing optimistic message identity. It must be a UUID.
- `cwd` remains optional and unrelated to model selection.

Success responses are unchanged:

```json
{
  "message_id": "a13a2c54-2939-44d7-9e95-b0772502569d",
  "client_id": "0196f0f2-0f4f-7c0f-8b5b-70eb50e1f55c"
}
```

Duplicate retries with the same owned-thread `client_id` can return `200` with the existing persisted ids. Fresh sends return `201`.

## Error Handling

The service accepts the broad enum syntactically, then validates semantics against the selected model.

Unsupported reasoning example:

```json
{
  "error": "invalid_reasoning_effort",
  "message": "Reasoning effort xhigh is not supported for claude-opus-4-6. Supported values: low, medium, high, max.",
  "model": "claude-opus-4-6",
  "supported_values": ["low", "medium", "high", "max"]
}
```

Unsupported model example:

```json
{
  "error": "invalid_model",
  "message": "Model is not available: gpt-5.2",
  "model": "gpt-5.2"
}
```

Recommended client behavior:

1. On `invalid_reasoning_effort`, refetch `/api/models`.
2. Keep the selected model if it still exists.
3. Reset reasoning to `reasoning.default_level` for that model.
4. Let the user retry the send.
5. On `invalid_model`, refetch `/api/models` and reset model selection using the normal selection rules.

## UI Guidance

Recommended controls:

- Model picker: label from `display_name`.
- Reasoning picker: labels from `reasoning.levels[].label`.
- Reasoning disabled/hidden: only when the selected model has exactly one `none` level.
- Saved settings: store product `id` and reasoning `value`, but validate both after every `/api/models` fetch.

Do not show provider model ids as the primary user-facing label. They are useful in diagnostics, settings detail views, or debug panels.

## Streaming Impact

The agent SSE contract does not change for this handoff.

Existing thread stream events remain:

- `agent.message_start`
- `agent.message_delta`
- `agent.message_done`
- `agent.tool_call`
- `agent.tool_result`
- `agent.message`
- `thread.title`
- `final`

There is a separate TODO to improve first-visible-token UX and provider timing instrumentation. Mobile does not need to wait for that work before adopting `/api/models`.

## Validation Checklist For iOS

- [ ] App fetches `/api/models` after authenticated bootstrap.
- [ ] App selects `default_model` when no saved model is valid.
- [ ] App falls back to first available model if `default_model` is `null` or absent.
- [ ] App handles `models: []` without crashing.
- [ ] App renders reasoning choices from the selected model only.
- [ ] App supports `xhigh` and `max` values.
- [ ] App resets `xhigh` when switching from Opus 4.7 to Opus 4.6.
- [ ] App resets `max` when switching from Opus 4.6 to GPT-5.4.
- [ ] App hides/disables reasoning for single-`none` model entries if such entries are added later.
- [ ] Existing-thread send includes product `model` and supported `reasoning_effort`.
- [ ] Send before model metadata load omits both fields and still succeeds.
- [ ] `400 invalid_reasoning_effort` refetches models and resets effort.
- [ ] `400 invalid_model` refetches models and resets model.
- [ ] Existing SSE thread streaming still works with selected model/reasoning.

## Related Backend Files

- `service/src/routes/models.ts`
- `service/src/routes/threads/shared.ts`
- `service/src/routes/threads/messages.ts`
- `service/src/llm/model-catalog.ts`
- `service/src/llm/reasoning-policy.ts`
- `web/src/lib/models.ts`
- `plan/llm-models/mobile-handoff.md`
