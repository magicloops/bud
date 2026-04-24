# Implementation Spec: LLM Models And Reasoning Controls

**Status**: Implemented; automated validation complete; live smoke deferred
**Created**: 2026-04-23
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 1**: [phase-1-service-catalog-and-reasoning-policy.md](./phase-1-service-catalog-and-reasoning-policy.md)
**Phase 2**: [phase-2-provider-adapters-and-model-rollout.md](./phase-2-provider-adapters-and-model-rollout.md)
**Phase 3**: [phase-3-api-contract-and-client-adoption.md](./phase-3-api-contract-and-client-adoption.md)
**Phase 4**: [phase-4-validation-docs-and-handoff.md](./phase-4-validation-docs-and-handoff.md)
**Related Design**: [../../design/llm-model-catalog-and-reasoning-controls.md](../../design/llm-model-catalog-and-reasoning-controls.md)

---

## Context

Bud already supports OpenAI and Anthropic through `service/src/llm`, but the product model list and reasoning controls are spread across provider classes, the registry, route response shaping, config parsing, request validation, and web UI state.

Current problems:

- adding a new model requires touching too many files
- `/api/models` does not tell clients which reasoning values are valid per model
- `reasoning_effort` is globally validated as `none | low | medium | high`
- Claude 4.6/4.7 reasoning uses `output_config.effort`, not the older manual `thinking.budget_tokens` path
- GPT-5.4 adds `xhigh`, while Anthropic adds `max` and only Opus 4.7 adds `xhigh`

This plan implements the model refresh and changes Bud's model inventory into a catalog-backed contract.

## Objective

Make model additions fast and low-risk by centralizing model metadata and exposing provider/model-specific reasoning controls through `/api/models`.

Target model list:

| Provider | Product IDs | Default |
| --- | --- | --- |
| Anthropic | `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-opus-4-7` | `claude-opus-4-6` |
| OpenAI | `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.5` | no global default |

## Fixed Decisions

- Create a service-owned code catalog rather than database-backed model rows.
- Expose product IDs only through first-party UI; provider snapshots stay metadata.
- Do not add an `available` boolean to the catalog or `/api/models`.
- Treat GPT-5.5 as live and validate it with a smoke test before handoff.
- Expose `none`, `low`, `medium`, `high`, and `xhigh` for GPT-5.4, GPT-5.4 mini, GPT-5.4 nano, and GPT-5.5.
- Use Opus 4.6 as the global default model.
- Use Opus 4.7 default effort `xhigh`.
- Use Sonnet 4.6 default effort `medium`.
- Upgrade `@anthropic-ai/sdk` during implementation.
- Do not keep a mobile compatibility window for `xhigh` or `max`; clients should consume `/api/models`.

## Resolved Implementation Decisions

1. Haiku 4.5 reasoning:
   - Expose `none`, `low`, `medium`, `high` and map non-`none` values to manual `thinking.budget_tokens`.

2. Claude thinking display:
   - Use `summarized` for Opus 4.6 and Sonnet 4.6.
   - Use `omitted` for Opus 4.7.

3. Old model compatibility:
   - Remove GPT-5.2 and Claude 4.5 from the first-party catalog and `/api/models`.
   - Keep hidden provider/registry tolerance for legacy env overrides and explicit old model IDs.

## Success Criteria

- [x] one catalog entry is enough for most future model additions
- [x] `/api/models` returns provider/model-specific reasoning levels and defaults
- [x] web derives model and reasoning selector state from `/api/models`
- [x] unsupported model/reasoning combinations fail with a clear 400 before agent execution starts
- [x] Anthropic Opus 4.6/Sonnet 4.6/Opus 4.7 use `output_config.effort`
- [x] Anthropic Opus 4.7 does not send manual `thinking.budget_tokens`
- [x] OpenAI GPT-5.4 family supports `xhigh`
- [-] GPT-5.5 is exposed; live smoke remains deferred until real provider credentials/model access are available
- [x] service/web specs and environment docs are updated

## Non-Goals

- database-admin model management
- pricing/rate-limit UI
- provider health checks or dynamic availability flags
- mobile repo implementation work
- changing Bud daemon protocol
- adding a dedicated reasoning-summary UI

## Ownership And Permission Boundaries

This plan changes browser-facing service routes but does not introduce new user-owned rows.

- `GET /api/models` exposes static product metadata filtered by configured providers; it does not read user-owned data.
- `POST /api/threads/:thread_id/messages` continues to authorize through the existing thread ownership path before reading, writing, or starting a turn.
- `reasoning_effort` validation must happen after resolving the authorized thread/message request and selected model, but before starting the agent turn.
- No database schema changes are planned.
- No SSE or Bud WebSocket wire events are planned.

## Impacted Contracts

| Contract | Impact |
| --- | --- |
| `GET /api/models` | Add per-model `reasoning` metadata; remove hardcoded display-name behavior from the route |
| `POST /api/threads/:thread_id/messages` | Broaden accepted `reasoning_effort` values and validate them against the selected model |
| Agent model config | Replace global reasoning normalization with catalog policy lowering |
| Web composer | Derive reasoning options from selected model metadata |
| Mobile clients | Adopt `/api/models` as source of truth; no compatibility window needed |

No DB schema, WSS protocol, or SSE event-shape changes are expected.

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
| --- | --- | --- | --- |
| 1 | [phase-1-service-catalog-and-reasoning-policy.md](./phase-1-service-catalog-and-reasoning-policy.md) | Urgent | Service has a central catalog and model-specific reasoning policy |
| 2 | [phase-2-provider-adapters-and-model-rollout.md](./phase-2-provider-adapters-and-model-rollout.md) | Urgent | Providers can invoke the new models with correct request shapes |
| 3 | [phase-3-api-contract-and-client-adoption.md](./phase-3-api-contract-and-client-adoption.md) | High | `/api/models`, web, and mobile-facing semantics use catalog metadata |
| 4 | [phase-4-validation-docs-and-handoff.md](./phase-4-validation-docs-and-handoff.md) | High | Tests, live smoke checks, specs, docs, and handoff are complete |

## Expected Files And Areas

### Service

- `service/src/llm/model-catalog.ts`
- `service/src/llm/reasoning-policy.ts`
- `service/src/llm/registry.ts`
- `service/src/llm/types.ts`
- `service/src/llm/providers/openai.ts`
- `service/src/llm/providers/anthropic.ts`
- `service/src/llm/index.ts`
- `service/src/config.ts`
- `service/src/routes/models.ts`
- `service/src/routes/threads/shared.ts`
- `service/src/agent/model-runner.ts`
- `service/package.json`
- `service/pnpm-lock.yaml`

### Web

- `web/src/lib/models.ts`
- `web/src/components/workbench/command-composer.tsx`
- `web/src/routes/$budId/new.tsx`
- `web/src/routes/$budId/$threadId.tsx`

### Docs And Specs

- `service/src/llm/llm.spec.md`
- `service/src/llm/providers/providers.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/routes/routes.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `service/.env.example`
- `service/README.md`
- `bud.spec.md`

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Anthropic SDK typings lag new request fields | Medium | Medium | Upgrade SDK first; isolate any temporary casts inside the Anthropic provider |
| GPT-5.5 docs/API access lag the product decision | Medium | High | Treat as live but require smoke validation before handoff |
| Reasoning values are accepted globally but fail provider calls | Medium | High | Validate selected effort against catalog before agent turn starts |
| Web sends stale reasoning value after model change | Medium | Medium | Reset unsupported values to selected model default |
| Old transcripts/env overrides reference removed models | Medium | Medium | Decide hidden provider tolerance before removing old model support |
| Haiku manual thinking changes fast-model latency expectations | Medium | Medium | Gate Haiku reasoning decision before provider rollout |

## Rollout Strategy

1. Land catalog and policy behind existing provider behavior.
2. Update providers and models with request-shape tests.
3. Switch `/api/models` and web to consume catalog metadata.
4. Run automated tests and live smoke checks.
5. Update specs/docs and hand off the mobile contract.

## Definition Of Done

- [x] service catalog and reasoning policy are implemented and tested
- [x] OpenAI and Anthropic providers invoke the requested model set
- [x] `/api/models` exposes model-specific reasoning controls
- [x] web uses `/api/models` for model and reasoning options
- [x] unsupported efforts return clear 400s before turn start
- [-] live smoke tests pass for Opus 4.7 `xhigh`, Opus 4.6 `max`, GPT-5.4 `xhigh`, and GPT-5.5
- [x] specs, README, and `.env.example` match shipped defaults
- [x] [progress-checklist.md](./progress-checklist.md) and [validation-checklist.md](./validation-checklist.md) are updated with final status
