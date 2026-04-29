# Phase 2: Thread API And Message Metadata

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Proposed

---

## Objective

Adopt the shared resolver in service routes so thread selections are persisted, returned to clients, and recorded on new message metadata.

By the end of this phase:

- `/api/models` reports `gpt-5.5` + `low` defaults
- thread serializers include stored and effective model selection fields
- `PATCH /api/threads/:thread_id/model-preference` updates owned thread selection
- `POST /api/threads` always stores an initial selection
- `POST /api/threads/:thread_id/messages` resolves and persists selection before agent start
- user, assistant, and tool messages store effective model/reasoning metadata

## Scope

### In Scope

- `service/src/routes/models.ts`
- `service/src/routes/threads/`
- thread serializer/shared route helpers
- `AgentService.startUserMessage(...)` call path
- transcript writer/message metadata helpers
- service route and agent tests
- route, agent, DB, and migration spec updates if implementation lands in this phase

### Out Of Scope

- Web selector refactor
- Mobile client implementation
- Historical metadata backfill
- New SSE event shapes

## API Tasks

### Task 1: Update `/api/models`

Return default fields:

```json
{
  "service_default_model": "gpt-5.5",
  "default_model": "gpt-5.5",
  "default_reasoning_effort": "low"
}
```

Preserve existing model catalog fields so current web and mobile clients remain compatible.

### Task 2: Extend thread serializers

Add fields to thread detail and thread-list summaries:

```json
{
  "model": "gpt-5.5",
  "reasoning_effort": "low",
  "effective_model": "gpt-5.5",
  "effective_reasoning_effort": "low",
  "model_selection_source": "thread"
}
```

Rules:

- `model` and `reasoning_effort` represent stored thread values.
- old threads may return `null` for stored values.
- effective fields are always valid.
- `model_selection_source` is `thread` or `service_default`.
- serialize only after the route has scoped the thread query to the authenticated viewer.

### Task 3: Add thread model-preference PATCH route

Add `PATCH /api/threads/:thread_id/model-preference`.

Validation:

- `401` for unauthenticated requests.
- `404` for authenticated cross-user access.
- `400 invalid_model` for unknown or unavailable models.
- `400 invalid_reasoning_effort` for unsupported reasoning.
- `model: null` is not a clear operation and returns `400 invalid_model`.
- omitted/null `reasoning_effort` resolves to the selected model's default and persists the concrete value.

The route should return the same stored/effective selection shape as thread responses.

### Task 4: Persist selection on thread creation

Update `POST /api/threads`:

- validate submitted `model` and `reasoning_effort` before insert
- use `gpt-5.5` + `low` when no model is submitted
- resolve omitted/null reasoning to a concrete value
- insert `thread.model_id` and `thread.reasoning_effort` on every new thread
- keep existing Bud ownership and `created_by_user_id` stamping behavior

### Task 5: Persist selection on message send

Update `POST /api/threads/:thread_id/messages`:

- authorize the thread before reading or updating selection
- resolve selection before duplicate handling, context sync, message insert, or agent start
- if an explicit valid request selection exists, update the thread selection
- if the thread has no selection, backfill the resolved service default selection
- pass the effective model/reasoning to the agent start path
- make duplicate retries deterministic and avoid changing selection differently on retry

### Task 6: Record message metadata

Persist effective selection metadata on new user, assistant, and tool messages:

```json
{
  "model": "gpt-5.5",
  "reasoning_effort": "low",
  "model_selection_source": "explicit_request"
}
```

Implementation requirements:

- merge with existing metadata instead of replacing it
- preserve `preferred_cwd`
- preserve terminal/tool metadata
- use the same turn-level effective selection for user, assistant, and tool messages
- do not backfill historical messages

## Service Tests

Add or update tests for:

- `/api/models` defaults to `gpt-5.5` + `low`
- thread detail returns stored/effective selection
- thread list returns stored/effective selection
- owned PATCH updates thread selection
- cross-user PATCH returns `404`
- invalid model returns `400 invalid_model`
- invalid reasoning returns `400 invalid_reasoning_effort`
- `model: null` is rejected
- thread creation stores submitted selection
- thread creation without selection stores service default
- message send explicit selection updates thread selection
- message send on old null-selection thread backfills service default
- metadata is stored on user, assistant, and tool messages
- duplicate retries do not create divergent thread selection writes

## Ownership Notes

Do not add route-local shortcuts that fetch threads globally and filter in memory. Use existing ownership-aware thread and Bud helpers. Any terminal/session reads triggered by message send must remain behind the authorized thread path.

## Validation Checklist

- [ ] `/api/models` default fields are correct
- [ ] thread list includes model selection fields
- [ ] thread detail includes model selection fields
- [ ] PATCH route enforces ownership
- [ ] PATCH route rejects invalid model/reasoning
- [ ] new thread writes always populate model columns
- [ ] message send updates thread selection for explicit requests
- [ ] message send backfills old null-selection threads
- [ ] user message metadata includes effective selection
- [ ] assistant message metadata includes effective selection
- [ ] tool message metadata includes effective selection

## Exit Criteria

This phase is done when service APIs fully implement the persisted thread-selection contract and automated route/agent tests cover the behavior.
