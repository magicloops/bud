# Phase 3: Bud-Scoped Model Inventory And Selection

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented

---

## Objective

Make model inventory and model selection environment-aware so Bud-local ds4 models are visible and usable only for the owning Bud.

By the end of this phase:

- `/api/models?bud_id=<owned-bud-id>` appends healthy Bud-local ds4 models
- `/api/models` without `bud_id` keeps the current global provider behavior
- non-owners receive `404` for another user's Bud-scoped model inventory
- message send validates explicit ds4 selections against the authorized thread's Bud
- unavailable local models fail clearly before durable user-message side effects

## Scope

### In Scope

- `service/src/routes/models.ts`
- route ownership helpers such as `getAuthorizedBud`
- thread/message request validation in `service/src/routes/threads/`
- model preference resolution if existing thread preferences can name ds4
- web API model helper and selectors
- route and model-selection tests

### Out Of Scope

- daemon stream invocation
- direct local-dev provider implementation beyond inventory behavior from Phase 1
- mobile-specific UI work beyond API contract notes
- database schema changes unless implementation adds separate capability-health rows

## API Contract

Global model inventory remains:

```text
GET /api/models
```

Bud-scoped inventory adds:

```text
GET /api/models?bud_id=<owned-bud-id>
```

Bud-local ds4 model response shape should include locality metadata:

```json
{
  "id": "ds4-deepseek-v4-flash",
  "provider": "ds4",
  "provider_model": "deepseek-v4-flash",
  "display_name": "ds4 DeepSeek V4",
  "request_mode": "ds4_openai_responses",
  "compatibility": ["openai_responses"],
  "source": {
    "kind": "bud_local",
    "bud_id": "b_..."
  }
}
```

If `bud_id` is absent, do not include Bud-local models.

### Responses API Deltas

The model inventory should expose ds4 as a Responses-backed local model, not as a generic OpenAI-compatible endpoint selector:

- include `request_mode: "ds4_openai_responses"` or equivalent metadata if the existing response shape has a request-mode field
- include only `openai_responses` compatibility for Bud-local ds4
- do not expose Chat Completions, Anthropic Messages, `/v1/responses`, `/v1/chat/completions`, or any raw local URL as user-selectable options
- keep `reasoning_effort` behavior aligned with the catalog: ds4 exposes
  `Fast` and `Thinking`, while `max` is hidden until the effective context
  window reaches the ds4 max-thinking threshold
- unavailable-state messaging should say the Bud-local model is unavailable, not that a different endpoint/mode should be selected

## Implementation Tasks

### Task 1: Authorize Bud-scoped inventory

When `bud_id` is present:

- require authenticated viewer
- resolve the Bud through ownership-aware helpers
- return `404` for signed-in non-owners
- append only local models from healthy `capabilities.llm.servers`

Do not fetch all Buds and filter in memory.

### Task 2: Project local capability metadata into catalog response

Map daemon model metadata into the existing model-list response shape.

Rules:

- use stable product id `ds4-deepseek-v4-flash`
- preserve provider id `ds4`
- include provider model `deepseek-v4-flash`
- include Responses request mode/compatibility metadata if the route shape supports it
- include context/output metadata when available
- include `source.kind = "bud_local"` and the authorized `bud_id`
- avoid advertising raw local URLs

### Task 3: Validate selected model before message persistence

For message send:

- authorize the thread
- derive the owning Bud from the thread
- resolve selected model from request or thread preference
- if selected model is ds4, verify the Bud has healthy ds4 capability
- reject unavailable ds4 before inserting the user message

Suggested errors:

- `400 invalid_model` when the model id is unknown for the thread environment
- `424 local_model_unavailable` when a known local model exists but is currently unhealthy or absent

### Task 4: Handle saved thread preferences

If thread model preferences already store a ds4 model:

- keep displaying the saved selection when possible
- show unavailable state if the Bud is offline or no longer advertises ds4
- prevent send until the user chooses an available model or ds4 becomes available again
- do not silently rewrite the preference to a cloud model

### Task 5: Update first-party web model loading

The web app should request Bud-scoped model inventory for Bud-scoped routes and thread composers.

Expected behavior:

- new-thread route loads models with the route Bud id
- existing-thread route loads models using the thread's Bud id
- local ds4 models are visually distinguishable from cloud models without implying privacy the system does not provide
- local ds4 models are not presented with endpoint or compatibility-mode controls
- stale/unavailable ds4 selections are rendered as unavailable, not removed without explanation

### Task 6: Add tests

Add coverage for:

- `/api/models` excludes Bud-local models
- owned `/api/models?bud_id=...` includes ds4 when capability is healthy
- owned `/api/models?bud_id=...` excludes ds4 when capability is absent/unhealthy
- non-owner Bud-scoped inventory returns `404`
- message send rejects ds4 for a thread whose Bud lacks ds4
- rejection happens before user-message insert
- cloud model selection remains unchanged

## Validation Checklist

- [x] global `/api/models` behavior unchanged
- [x] Bud-scoped `/api/models` authorizes Bud ownership
- [x] healthy Bud-local ds4 appears for owner
- [x] Bud-local ds4 appears as Responses-backed only
- [x] absent/unhealthy ds4 does not appear
- [x] non-owner receives `404`
- [x] message send validates ds4 against thread Bud
- [x] unavailable ds4 fails before user-message persistence
- [x] web requests Bud-scoped inventory on Bud/thread routes

## Exit Criteria

This phase is done when ds4 is discoverable and selectable only in the correct Bud environment, with explicit failures instead of fallback when the local model is unavailable.
