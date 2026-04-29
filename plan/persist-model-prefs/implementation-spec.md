# Implementation Spec: Persist Thread Model Preferences

**Status**: Proposed
**Created**: 2026-04-28
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-service-default-schema-and-resolver.md](./phase-1-service-default-schema-and-resolver.md)
**Phase 2**: [phase-2-thread-api-and-message-metadata.md](./phase-2-thread-api-and-message-metadata.md)
**Phase 3**: [phase-3-web-selector-persistence.md](./phase-3-web-selector-persistence.md)
**Phase 4**: [phase-4-validation-docs-and-mobile-handoff.md](./phase-4-validation-docs-and-mobile-handoff.md)
**Related Design**: [../../design/model-preferences-and-thread-overrides.md](../../design/model-preferences-and-thread-overrides.md)

---

## Context

Bud's web model selector currently keeps model and reasoning state in route-local React state. The client sends `model` and `reasoning_effort` on message creation, but the service does not persist the selection on the thread. Route remounts, reloads, and navigation can reset the selector to the service default and normalize reasoning to the wrong model default.

This plan implements thread-scoped model selection persistence. There are no per-user or per-Bud defaults in this pass.

## Objective

Persist each thread's selected model and reasoning effort, default new work to `gpt-5.5` with `low` reasoning, and record the effective model/reasoning used by each new user, assistant, and tool message.

## Fixed Decisions

- The only persisted preference is per-thread.
- The service default is `gpt-5.5` with reasoning `low` when no thread selection exists.
- New threads always store the submitted model/reasoning selection as the thread selection.
- There is no clear-override action. Users change a thread by selecting another valid model/reasoning combination.
- Existing clients may continue sending `model` and `reasoning_effort` on `POST /api/threads/:thread_id/messages`.
- Assistant and tool message metadata should record the effective model/reasoning used for the turn, alongside user message metadata.

## Non-Goals

- Per-user model defaults.
- Per-Bud model defaults.
- Organization/team model policy.
- Provider API key management.
- Historical backfill of model metadata on existing messages.
- Bud daemon protocol changes.

## Ownership And Permission Boundaries

This plan changes browser-facing thread reads and writes. All resource access must stay owner-scoped.

- `GET /api/models` remains static/catalog-backed and does not read user-owned data.
- `GET /api/threads`, `GET /api/threads/:thread_id`, and thread summaries must only expose model fields after SQL has filtered to the authenticated viewer.
- `PATCH /api/threads/:thread_id/model-preference` must resolve the thread through the existing ownership-aware helper. Cross-user access returns `404`.
- `POST /api/threads` must resolve the requested Bud through the existing owned-Bud path before creating the thread and stamping `created_by_user_id`.
- `POST /api/threads/:thread_id/messages` must resolve the thread through ownership before reading or updating model fields, inserting messages, syncing context, or starting the agent turn.
- No new table is introduced. The new `thread` columns inherit ownership from the existing thread row.
- Message metadata writes must preserve existing metadata such as `preferred_cwd` and tool-specific metadata.

## Target Semantics

Selection resolution order:

1. Explicit message request body, when present and valid.
2. Thread model selection, when present and valid.
3. Service default: `gpt-5.5` with reasoning `low`.

When a submitted model is valid and `reasoning_effort` is omitted or `null`, the service resolves the model's default reasoning and persists the concrete resolved value.

When an existing stored model is no longer available, the service returns the service default as the effective selection while preserving the stored values for later human correction. The implementation should not silently delete or rewrite unavailable stored values during reads.

## Data Model

Add nullable columns to `thread`:

```text
model_id text
reasoning_effort text
```

The columns remain nullable to support existing threads and safe rollout. New thread writes should populate both columns with a valid product model ID and resolved reasoning effort.

Reasoning remains text rather than a PostgreSQL enum because provider/model reasoning levels are catalog-owned and can change faster than schema.

## API Contract

### `GET /api/models`

Return the existing model catalog response, with service defaults changed to:

```json
{
  "service_default_model": "gpt-5.5",
  "default_model": "gpt-5.5",
  "default_reasoning_effort": "low"
}
```

Existing clients that only read `default_model` should initialize to `gpt-5.5`.

### Thread Responses

Extend thread detail and thread summary responses:

```json
{
  "model": "gpt-5.5",
  "reasoning_effort": "low",
  "effective_model": "gpt-5.5",
  "effective_reasoning_effort": "low",
  "model_selection_source": "thread"
}
```

`model` and `reasoning_effort` are the stored thread values and may be `null` for old threads. `effective_model` and `effective_reasoning_effort` are always the valid values the server would use for a turn.

`model_selection_source` values:

- `thread`
- `service_default`

### `PATCH /api/threads/:thread_id/model-preference`

Authenticated owned-thread route for changing the thread selection.

Request:

```json
{
  "model": "gpt-5.5",
  "reasoning_effort": "low"
}
```

Rules:

- `model` must be a configured catalog model.
- `reasoning_effort` may be omitted or `null` to use the selected model's default.
- The server persists the concrete resolved model and reasoning effort.
- `model: null` is not a clear operation and should return `400 invalid_model`.
- Cross-user access returns `404`.

### `POST /api/threads`

Allow an initial selection:

```json
{
  "bud_id": "bud_123",
  "title": "Optional",
  "model": "gpt-5.5",
  "reasoning_effort": "low"
}
```

Rules:

- If `model` is submitted, validate it before creating the thread.
- If `reasoning_effort` is omitted or `null`, resolve the selected model's default and persist that value.
- If `model` is omitted for backward compatibility, use and persist `gpt-5.5` + `low`.
- The created thread always has stored model/reasoning values.

### `POST /api/threads/:thread_id/messages`

Rules:

- Resolve model selection before duplicate handling, context sync, message insert, or agent start.
- If the request has a valid explicit `model`, update the thread selection to the resolved model/reasoning before starting the turn.
- If the thread has no stored selection, resolve and persist the service default before starting the turn.
- Persist the effective selection in new user, assistant, and tool message metadata for the turn.
- Pass the effective model/reasoning to `AgentService.startUserMessage(...)`.

Message metadata fields:

```json
{
  "model": "gpt-5.5",
  "reasoning_effort": "low",
  "model_selection_source": "explicit_request"
}
```

`model_selection_source` values for message metadata:

- `explicit_request`
- `thread`
- `service_default`

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
| --- | --- | --- | --- |
| 1 | [phase-1-service-default-schema-and-resolver.md](./phase-1-service-default-schema-and-resolver.md) | Urgent | Service has defaults, schema, migration, and a shared resolver |
| 2 | [phase-2-thread-api-and-message-metadata.md](./phase-2-thread-api-and-message-metadata.md) | Urgent | Thread routes persist/return selections and messages record metadata |
| 3 | [phase-3-web-selector-persistence.md](./phase-3-web-selector-persistence.md) | High | Web initializes from and persists thread selection without route resets |
| 4 | [phase-4-validation-docs-and-mobile-handoff.md](./phase-4-validation-docs-and-mobile-handoff.md) | High | Tests, specs, migration docs, and mobile handoff are complete |

## Expected Files And Areas

### Service

- `service/src/config.ts`
- `service/src/db/schema.ts`
- `service/drizzle/migrations/`
- `service/src/llm/model-catalog.ts`
- `service/src/llm/reasoning-policy.ts`
- `service/src/routes/models.ts`
- `service/src/routes/threads/`
- `service/src/agent/model-runner.ts`
- `service/src/agent/transcript-writer.ts`
- `service/src/agent/agent-service.ts`

### Web

- `web/src/lib/models.ts`
- `web/src/lib/api.ts`
- `web/src/components/workbench/command-composer.tsx`
- `web/src/routes/$budId/new.tsx`
- `web/src/routes/$budId/$threadId.tsx`

### Docs And Specs

- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/llm/llm.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `service/.env.example`
- `service/README.md`
- `bud.spec.md`

## Impacted Contracts

| Contract | Impact |
| --- | --- |
| DB schema | Add nullable `thread.model_id` and `thread.reasoning_effort`; generate checked-in migration |
| `GET /api/models` | Change default model/reasoning to `gpt-5.5` + `low`; expose `default_reasoning_effort` |
| Thread reads | Add stored/effective model selection fields |
| `PATCH /api/threads/:thread_id/model-preference` | New owned-thread write route |
| `POST /api/threads` | Accept and persist initial selection |
| `POST /api/threads/:thread_id/messages` | Resolve/persist selection and metadata before agent start |
| Web composer | Initialize and persist selection through a shared hook |
| Mobile clients | Consume the same thread response fields and defaults |

No Bud WebSocket protocol change is expected. No SSE event-shape change is required unless implementation chooses to include model fields in an existing thread metadata update.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| `gpt-5.5` is not configured in a local/staging provider environment | Medium | High | Make the checked-in default explicit, validate configured defaults in tests, and document env requirements |
| Duplicate message retries mutate thread selection unexpectedly | Medium | High | Resolve once per accepted user message and test duplicate paths |
| Metadata writes overwrite existing message metadata | Medium | Medium | Merge model fields into metadata instead of replacing metadata objects |
| Web debounced PATCH races with message submit | Medium | Medium | Continue sending explicit selection on submit and let message route be authoritative |
| Old threads have null or unavailable model fields | High | Low | Thread serializers return effective service defaults without destructive cleanup |
| Mobile clients assume `default_model` is provider/catalog default only | Low | Medium | Document that `default_model` is the effective service default |

## Rollout Strategy

1. Land the service schema/default/resolver foundation with tests.
2. Wire thread routes and message metadata while preserving existing client request compatibility.
3. Adopt the contract in the web selector and keep submit payloads defensive.
4. Run validation, generate migrations, update specs/docs, and hand off mobile expectations.

## Definition Of Done

- [ ] `GET /api/models` defaults to `gpt-5.5` + `low`
- [ ] `thread` stores model and reasoning selection
- [ ] checked-in Drizzle migration exists for the schema change
- [ ] owned thread reads return stored and effective model selection fields
- [ ] owned thread PATCH route validates and persists selection
- [ ] new threads always store model/reasoning selection
- [ ] message send resolves selection by explicit request, thread, then service default
- [ ] user, assistant, and tool messages record effective selection metadata
- [ ] web selector persists existing-thread changes and survives remount/refresh
- [ ] mobile-facing contract is documented
- [ ] relevant specs and docs are updated
