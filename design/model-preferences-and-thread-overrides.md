# Model Preferences And Thread Overrides

**Date:** 2026-04-28
**Status:** Proposed

## Problem

The web model selector currently resets to the service default after route remounts, reloads, or navigation. A user can select `gpt-5.5` with reasoning `low`, but the next mount calls `GET /api/models`, receives `default_model: "claude-opus-4-6"`, and then normalizes reasoning to Claude Opus 4.6's default `high`.

The selected model and reasoning level are sent on each `POST /api/threads/:thread_id/messages`, but they are not persisted as user preferences or thread state. The service only stores user-message metadata such as `preferred_cwd`.

## Goals

- Persist a signed-in user's default model and reasoning level for new work.
- Persist an optional per-thread override so existing threads reopen with their last selected model/reasoning.
- Keep server-side validation as the source of truth for model/reasoning compatibility.
- Preserve current request compatibility: clients may continue sending `model` and `reasoning_effort` with each message.
- Give web and mobile the same API contract.

## Non-Goals

- Model-provider API key management.
- Per-Bud defaults.
- Organization/team policy controls.
- Historical reconstruction of which model generated every existing assistant message.

## Current Behavior

### Web

- `useAvailableModels()` initializes `selectedModel` to `""`.
- The hook fetches `/api/models`.
- If no current selection exists, it selects `default_model` from the response or the first model.
- New-thread and existing-thread routes each own their own `reasoningEffort` state initialized to `none`.
- A route effect normalizes the current reasoning value against the selected model and falls back to that model's default.

### Service

- `GET /api/models` returns catalog entries and a service/catalog default.
- `POST /api/threads/:thread_id/messages` accepts optional `model` and `reasoning_effort`.
- The route validates that pair before message insert and agent start.
- The selected values are passed to `AgentService.startUserMessage(...)`.
- The selected values are not written to `user_profile`, `thread`, or `message.metadata`.

## Proposed Semantics

Selection resolution should follow this precedence:

1. Explicit message request body, when present and valid.
2. Thread override, when present and valid.
3. User model preference, when present and valid.
4. Service/catalog default model and its default reasoning level.

Thread override wins for existing threads. User preference is the default for new threads and threads that have no override.

If a stored model is no longer available because the provider is disabled or catalog changed, the service should return the nearest valid effective selection while preserving the stored preference for now. The client can show the effective value without immediately deleting the old preference.

## Data Model

### `user_profile`

Add nullable columns:

```text
preferred_model_id text
preferred_reasoning_effort text
```

These are user-owned defaults. They should store product model IDs such as `gpt-5.5`, not provider model snapshots such as `gpt-5.5-2026-04-23`.

### `thread`

Add nullable columns:

```text
model_id text
reasoning_effort text
```

These columns are the per-thread override. They should also store product model IDs.

Reasoning effort remains text rather than a PostgreSQL enum because provider/catalog levels have changed frequently and are already validated at the service boundary.

### Message Metadata

For forward observability, add the effective selection to newly inserted user message metadata:

```json
{
  "model": "gpt-5.5",
  "reasoning_effort": "low",
  "model_selection_source": "explicit_request"
}
```

This is not the source of truth for future turns; it is an audit/debug breadcrumb for that user request.

## API Changes

### `GET /api/models`

Keep the existing response fields, but clarify that `default_model` becomes the effective default for the current viewer.

Add:

```json
{
  "service_default_model": "claude-opus-4-6",
  "default_model": "gpt-5.5",
  "default_reasoning_effort": "low",
  "user_preference": {
    "model": "gpt-5.5",
    "reasoning_effort": "low",
    "effective_model": "gpt-5.5",
    "effective_reasoning_effort": "low",
    "valid": true
  }
}
```

Compatibility note: existing clients that only read `default_model` will start getting the user's effective default instead of the service default.

### `PATCH /api/me/model-preference`

Authenticated route for global user defaults.

Request:

```json
{
  "model": "gpt-5.5",
  "reasoning_effort": "low"
}
```

Clear preference:

```json
{
  "model": null,
  "reasoning_effort": null
}
```

Response:

```json
{
  "model": "gpt-5.5",
  "reasoning_effort": "low",
  "effective_model": "gpt-5.5",
  "effective_reasoning_effort": "low",
  "valid": true
}
```

Validation:

- `401` for unauthenticated requests.
- `400 invalid_model` when the model is not a configured catalog model.
- `400 invalid_reasoning_effort` when the reasoning value is unsupported by the selected model.
- `model: null` clears both fields.
- `reasoning_effort: null` means use the selected model's default reasoning.

### Thread Responses

Extend `GET /api/threads`, `GET /api/threads/:thread_id`, and thread-list summaries:

```json
{
  "model": "gpt-5.5",
  "reasoning_effort": "low",
  "effective_model": "gpt-5.5",
  "effective_reasoning_effort": "low",
  "model_selection_source": "thread"
}
```

`model_selection_source` values:

- `thread`
- `user`
- `service_default`

### `PATCH /api/threads/:thread_id/model-preference`

Authenticated owned-thread route for per-thread overrides.

Request:

```json
{
  "model": "gpt-5.5",
  "reasoning_effort": "low"
}
```

Clear override:

```json
{
  "model": null,
  "reasoning_effort": null
}
```

The route must use the existing thread ownership boundary. Cross-user access returns `404`.

### `POST /api/threads`

Allow optional initial thread override:

```json
{
  "bud_id": "bud_123",
  "title": "Optional",
  "model": "gpt-5.5",
  "reasoning_effort": "low"
}
```

This prevents the new-thread flow from selecting GPT, sending the first message, navigating to the created thread, and then seeing the selector briefly reset before thread data catches up.

### `POST /api/threads/:thread_id/messages`

Recommended behavior:

- Resolve effective selection from request body, thread override, user preference, and service default.
- Validate before duplicate handling, context sync, message insert, or agent start.
- If the request body has a valid explicit selection, update the thread override to match it.
- Persist the effective selection in user-message metadata.
- Pass the effective model/reasoning to `AgentService.startUserMessage(...)`.

This keeps older web/mobile clients compatible: even if they only send `model` with the message and never call the new PATCH route, the thread becomes sticky after the first message.

## Web Changes

Replace route-local selector ownership with a shared hook:

```typescript
useModelSelection({ threadId?: string })
```

Responsibilities:

- Fetch `/api/models`.
- For new-thread mode, initialize from user preference/effective default.
- For existing-thread mode, initialize from thread effective selection.
- Normalize reasoning against selected model metadata.
- Persist user default changes in new-thread mode via `PATCH /api/me/model-preference`.
- Persist thread override changes in existing-thread mode via `PATCH /api/threads/:thread_id/model-preference`.
- Debounce or coalesce rapid selector changes.
- Expose pending/error state so the composer can stay usable even if persistence fails.

New-thread submit should pass the current selected model/reasoning to `POST /api/threads` and `POST /messages`.

Existing-thread submit can continue passing model/reasoning with the message as a defensive compatibility path, but the selector should already have patched the thread override.

## Mobile Changes

Mobile should use the same `/api/models`, `/api/me/model-preference`, and thread response fields. Native clients can cache the last effective selection locally for UI responsiveness, but server values should win after fetch.

The mobile interrupt/long-running terminal UI is unaffected.

## Service Implementation Notes

Add a small resolver helper near the LLM model policy:

```typescript
resolveEffectiveModelSelection({
  requestedModel,
  requestedReasoning,
  threadModel,
  threadReasoning,
  userModel,
  userReasoning,
  serviceDefaultModel
})
```

Return:

```typescript
{
  model: string,
  reasoningEffort: ReasoningLevel | null,
  source: "explicit_request" | "thread" | "user" | "service_default",
  modelReasoning: ResolvedModelReasoning
}
```

Use it from:

- `GET /api/models`
- thread serializers
- `PATCH /api/me/model-preference`
- `PATCH /api/threads/:thread_id/model-preference`
- `POST /api/threads`
- `POST /api/threads/:thread_id/messages`

## Migration Plan

1. Add nullable columns to `user_profile` and `thread`.
2. Run `pnpm db:push` for local development.
3. Generate checked-in Drizzle migration via `pnpm db:generate`.
4. Backfill nothing. Existing users and threads naturally fall back to service defaults.
5. Update specs:
   - `service/src/db/db.spec.md`
   - `service/src/routes/routes.spec.md`
   - `web/src/lib/lib.spec.md`
   - `web/src/routes/$budId/budId.spec.md`
   - `web/src/components/workbench/workbench.spec.md`
   - migration spec under `service/drizzle/migrations/` if present.

## Test Plan

Service:

- `GET /api/models` returns user effective default when a user preference exists.
- `PATCH /api/me/model-preference` validates model/reasoning and persists owned user preference.
- `GET /api/threads/:thread_id` returns thread override when present.
- `PATCH /api/threads/:thread_id/model-preference` enforces ownership and validation.
- `POST /api/threads` can create a thread with an initial override.
- `POST /messages` uses precedence order and stores effective selection metadata.
- Duplicate message retries do not accidentally update thread override differently.

Web:

- New-thread route initializes from user default.
- Existing-thread route initializes from thread override.
- Changing selectors persists and survives route remount.
- Changing models normalizes reasoning only when the old reasoning is invalid for the new model.
- Sending the first message from `/$budId/new` navigates to the new thread without resetting the selector.

Manual:

1. Select `gpt-5.5` + `low` on new thread.
2. Send first message.
3. Confirm the created thread opens with `gpt-5.5` + `low`.
4. Refresh browser.
5. Confirm the same thread still shows `gpt-5.5` + `low`.
6. Open a different existing thread with no override.
7. Confirm it uses the user default.

## Open Questions

- Should changing a selector inside an existing thread also update the global user default, or only the thread override?
- Should the UI expose an explicit "use as default" action to avoid implicit global preference writes?
- Should thread override clearing be visible in the composer, or only available through a future settings/menu surface?
- Should assistant/tool message metadata also record the model/reasoning used for the turn, or is user-message metadata enough for now?
