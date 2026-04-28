# Phase 1: Service Default, Schema, And Resolver

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Proposed

---

## Objective

Add the service foundation for thread-scoped model selection before route and UI adoption.

By the end of this phase:

- the checked-in service default is `gpt-5.5`
- GPT-5.5's default reasoning for Bud agent turns is `low`
- `thread` has nullable model-selection columns
- a shared resolver can compute valid effective selections from request, thread, and service defaults
- migration and focused resolver/schema tests exist

## Scope

### In Scope

- `service/src/config.ts`
- `service/src/llm/model-catalog.ts`
- `service/src/llm/reasoning-policy.ts`
- `service/src/db/schema.ts`
- `service/drizzle/migrations/`
- shared model-selection resolver module near existing LLM policy code
- tests for service defaults, schema shape, and selection resolution
- DB and LLM spec updates if implementation lands in this phase

### Out Of Scope

- Thread route response changes
- New thread PATCH route
- Message metadata writes
- Web selector changes
- Mobile handoff docs

## Implementation Tasks

### Task 1: Change the service default model

Update the service default model fallback from `claude-opus-4-6` to `gpt-5.5`.

Update all docs or examples touched in this phase that describe the default, including `.env.example` or README references if they are part of the same patch.

### Task 2: Make the default reasoning `low`

Ensure the effective default reasoning for `gpt-5.5` resolves to `low` when:

- `/api/models` reports default metadata
- a new thread omits reasoning
- an existing override-less thread sends a message without explicit reasoning

Prefer changing the catalog/policy source of truth rather than patching route-local defaults.

### Task 3: Add thread schema columns

Update `service/src/db/schema.ts`:

```text
thread.model_id text nullable
thread.reasoning_effort text nullable
```

Do not add user-profile columns. Do not add a PostgreSQL enum for reasoning effort.

### Task 4: Generate migration

Follow the repo's Drizzle workflow:

1. Run `pnpm db:push` from `service/` for local development.
2. Run `pnpm db:generate` from `service/` for checked-in staging/deploy migration files.
3. Review generated SQL and metadata.

If `db:push` or `db:generate` fails, capture the exact command and error output in a debug note and stop for human guidance.

### Task 5: Add a shared resolver

Add a helper near the model catalog/reasoning policy code:

```typescript
resolveEffectiveModelSelection({
  requestedModel,
  requestedReasoning,
  threadModel,
  threadReasoning,
  serviceDefaultModel,
})
```

Return:

```typescript
{
  model: string;
  reasoningEffort: ReasoningLevel | null;
  source: "explicit_request" | "thread" | "service_default";
  modelReasoning: ResolvedModelReasoning;
  storedModelValid: boolean;
}
```

Behavior:

- explicit request wins when valid
- valid thread selection wins when no explicit request exists
- service default is the final fallback
- invalid explicit request returns the same clear 400 behavior as current model validation
- invalid stored thread selection falls back to service default without deleting stored values
- omitted/null reasoning resolves to the selected model's default and returns a concrete value

### Task 6: Add focused tests

Cover:

- service default model is `gpt-5.5`
- default reasoning for GPT-5.5 resolves to `low`
- resolver precedence is explicit request, thread, service default
- invalid stored thread model falls back to service default
- invalid explicit model/reasoning fails
- omitted reasoning resolves to concrete default reasoning
- schema exports include nullable `thread.model_id` and `thread.reasoning_effort`

## Ownership Notes

This phase adds columns only. It should not expose new browser-facing data until Phase 2. The resolver should be pure or data-shape focused; authorization remains route-owned.

## Validation Checklist

- [ ] `DEFAULT_MODEL` fallback is `gpt-5.5`
- [ ] GPT-5.5 default reasoning resolves to `low`
- [ ] `thread.model_id` exists in `schema.ts`
- [ ] `thread.reasoning_effort` exists in `schema.ts`
- [ ] `pnpm db:push` has been run or failure captured
- [ ] `pnpm db:generate` has produced a checked-in migration or failure captured
- [ ] resolver tests cover precedence and invalid stored fallback
- [ ] no `user_profile` model-preference columns were added

## Exit Criteria

This phase is done when service code can compute the effective model/reasoning selection and the database can store thread-level selections, even before any route uses the new columns.
