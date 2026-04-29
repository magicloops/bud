# persist-model-prefs

Implementation planning documents for persisting Bud model/reasoning selection at the thread level.

## Purpose

This folder turns [../../design/model-preferences-and-thread-overrides.md](../../design/model-preferences-and-thread-overrides.md) into an actionable implementation and validation plan.

The plan assumes:

- model/reasoning preferences are persisted per thread only
- new work defaults to `gpt-5.5` with reasoning `low`
- new threads always store the submitted or resolved selection
- existing threads can change selection by choosing a different model/reasoning pair
- there is no clear-override action
- effective selection metadata is recorded on new user, assistant, and tool messages
- web and mobile consume the same service API contract

## Files

### `implementation-spec.md`

Parent implementation spec for the thread model-preference persistence rollout.

Documents:

- fixed product and API decisions
- ownership and permission boundaries
- data model and route contracts
- phase sequencing
- impacted contracts
- risks and definition of done

### `phase-1-service-default-schema-and-resolver.md`

Service foundation phase covering:

- `gpt-5.5` + `low` service defaults
- thread schema columns
- Drizzle migration generation
- shared model-selection resolver
- resolver and schema tests

### `phase-2-thread-api-and-message-metadata.md`

Service API phase covering:

- `/api/models` default fields
- thread response serialization
- `PATCH /api/threads/:thread_id/model-preference`
- thread creation selection persistence
- message-send selection resolution
- user/assistant/tool metadata recording

### `phase-3-web-selector-persistence.md`

Reference-web phase covering:

- shared model-selection hook/helper
- new-thread default initialization
- existing-thread initialization from effective selection
- existing-thread PATCH persistence
- defensive message-submit model payloads
- route-remount reset prevention

### `phase-4-validation-docs-and-mobile-handoff.md`

Finalization phase covering:

- service and web validation
- manual browser checks
- migration review
- spec/doc updates
- mobile API handoff notes

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual and automated verification checklist for the plan.

## Dependencies

- [../../design/model-preferences-and-thread-overrides.md](../../design/model-preferences-and-thread-overrides.md) - source design and resolved decisions
- [../../plan/llm-models/implementation-spec.md](../llm-models/implementation-spec.md) - current catalog-backed model/reasoning architecture this rollout builds on
- [../../service/src/llm/llm.spec.md](../../service/src/llm/llm.spec.md) - current LLM catalog and reasoning policy spec
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md) - route/API ownership
- [../../service/src/db/db.spec.md](../../service/src/db/db.spec.md) - database schema ownership
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - agent and transcript ownership
- [../../web/src/lib/lib.spec.md](../../web/src/lib/lib.spec.md) - web API/model helper ownership
- [../../web/src/routes/$budId/budId.spec.md](../../web/src/routes/$budId/budId.spec.md) - thread route and composer ownership
- [../../web/src/components/workbench/workbench.spec.md](../../web/src/components/workbench/workbench.spec.md) - composer component ownership
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## Resolved Decisions

- Per-user preferences are out of scope.
- Per-Bud defaults are out of scope.
- Thread creation stores a concrete selected model/reasoning pair.
- Message send remains backward compatible with explicit model/reasoning request fields.
- Message metadata records model selection for observability but is not the source of truth for future turns.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
