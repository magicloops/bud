# llm-models

Phased implementation planning documents for centralizing Bud's LLM model catalog, updating the first-party model list, and making reasoning controls provider/model-specific.

## Purpose

This folder turns [../../design/llm-model-catalog-and-reasoning-controls.md](../../design/llm-model-catalog-and-reasoning-controls.md) into an actionable service/web implementation plan.

The plan assumes:

- Claude Opus 4.6 is the global default model.
- Anthropic product models are Claude Opus 4.6, Claude Sonnet 4.6, Claude Haiku 4.5, and Claude Opus 4.7.
- OpenAI product models are GPT-5.4, GPT-5.4 mini, GPT-5.4 nano, and GPT-5.5.
- GPT-5.5 is treated as live for this rollout, with API smoke validation required before handoff.
- `/api/models` is the first-party client source of truth for model-specific reasoning options.
- Mobile does not need a compatibility window for new `xhigh` or `max` reasoning values.

## Files

### `implementation-spec.md`

Parent implementation spec for the LLM model catalog and reasoning-control rollout.

Documents:

- fixed product and API decisions
- remaining implementation decision gates
- phase sequencing
- impacted contracts
- risks and definition of done

### `phase-1-service-catalog-and-reasoning-policy.md`

Service foundation phase covering:

- `service/src/llm/model-catalog.ts`
- `service/src/llm/reasoning-policy.ts`
- registry/catalog resolution
- broadened reasoning validation
- service unit tests for defaults, uniqueness, and unsupported efforts

### `phase-2-provider-adapters-and-model-rollout.md`

Provider phase covering:

- OpenAI GPT-5.4/GPT-5.5 model support
- Anthropic Opus 4.6, Sonnet 4.6, Haiku 4.5, and Opus 4.7 model support
- Anthropic SDK upgrade
- provider-specific reasoning lowering
- provider request-shape tests

### `phase-3-api-contract-and-client-adoption.md`

Client contract phase covering:

- catalog-backed `GET /api/models`
- model-specific reasoning metadata
- web model/reasoning selector adoption
- unsupported-reasoning error behavior before agent turn start
- mobile handoff expectations for the same API contract

### `phase-4-validation-docs-and-handoff.md`

Finalization phase covering:

- automated test runs
- live provider smoke tests
- spec and docs updates
- environment example updates
- implementation handoff notes

### `mobile-handoff.md`

Mobile-client adoption notes for the catalog-backed `/api/models` contract, including no compatibility window for `xhigh`/`max`, model-change normalization rules, and current product model defaults.

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual verification checklist for the plan.

## Dependencies

- [../../design/llm-model-catalog-and-reasoning-controls.md](../../design/llm-model-catalog-and-reasoning-controls.md) - source design and provider research notes
- [../../plan/llm-provider-adapter.md](../../plan/llm-provider-adapter.md) - historical provider abstraction rollout
- [../../service/src/llm/llm.spec.md](../../service/src/llm/llm.spec.md) - current LLM abstraction spec
- [../../service/src/llm/providers/providers.spec.md](../../service/src/llm/providers/providers.spec.md) - current provider adapter spec
- [../../service/src/agent/agent.spec.md](../../service/src/agent/agent.spec.md) - agent model-runner ownership
- [../../service/src/routes/routes.spec.md](../../service/src/routes/routes.spec.md) - route/API ownership
- [../../web/src/lib/lib.spec.md](../../web/src/lib/lib.spec.md) - web API/model helper ownership
- [../../web/src/routes/$budId/budId.spec.md](../../web/src/routes/$budId/budId.spec.md) - thread route and composer ownership
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## Resolved Decisions

- Haiku 4.5 exposes `none`, `low`, `medium`, and `high`, with non-`none` values mapped to manual thinking budgets.
- Opus 4.6 and Sonnet 4.6 use summarized adaptive thinking; Opus 4.7 uses omitted adaptive thinking.
- GPT-5.2 and Claude 4.5 are removed from the first-party product catalog but remain hidden provider/registry compatibility for explicit old model IDs.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
