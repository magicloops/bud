# LLM Models Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

Use this as the running status board while the model catalog and reasoning-control rollout lands.

## Status Legend

- `[ ]` not yet started or not yet verified
- `[x]` implemented and verified
- `[-]` deferred or intentionally out of scope for now

## Phase 1: Service Catalog And Reasoning Policy

### Catalog

- [x] `service/src/llm/model-catalog.ts` exists
- [x] target Anthropic models are represented
- [x] target OpenAI models are represented
- [x] exactly one global default exists
- [x] global default is `claude-opus-4-6`
- [x] catalog has no public `available` flag
- [x] catalog entries have stable sort order

### Reasoning Policy

- [x] `ReasoningLevel` includes `xhigh` and `max`
- [x] request schema accepts the broad reasoning value set
- [x] semantic validation is model-specific
- [x] unsupported efforts return `invalid_reasoning_effort`
- [x] omitted effort resolves to the selected model default
- [x] registry resolves product IDs through the catalog

## Phase 2: Provider Adapters And Model Rollout

### OpenAI

- [x] GPT-5.4 supported
- [x] GPT-5.4 mini supported
- [x] GPT-5.4 nano supported
- [x] GPT-5.5 supported
- [x] GPT-5.4 family accepts `xhigh`
- [x] `none` reasoning does not accidentally force a higher effort

### Anthropic

- [x] `@anthropic-ai/sdk` upgraded
- [x] SDK request typings verified or provider-local casts isolated
- [x] Opus 4.6 supported
- [x] Sonnet 4.6 supported
- [x] Haiku 4.5 supported
- [x] Opus 4.7 supported
- [x] Opus 4.6/Sonnet 4.6 use `output_config.effort`
- [x] Opus 4.7 uses adaptive thinking and `output_config.effort`
- [x] Opus 4.7 does not send manual `budget_tokens`
- [x] Haiku 4.5 behavior follows the selected decision

## Phase 3: API Contract And Client Adoption

### Service API

- [x] `/api/models` is catalog-backed
- [x] `/api/models` returns `reasoning.kind`
- [x] `/api/models` returns `reasoning.levels`
- [x] `/api/models` returns `reasoning.default_level`
- [x] `/api/models` returns `default_model`
- [x] `/api/models` includes GPT-5.5 when OpenAI is configured
- [x] `/api/models` omits `available`
- [x] unsupported effort returns 400 before agent turn start

### Web

- [x] web model types match `/api/models`
- [x] composer derives reasoning options from selected model
- [x] model change resets unsupported reasoning value
- [x] composer hides/disables reasoning when only `none` is available
- [x] new-thread route sends valid model/reasoning payload
- [x] existing-thread route sends valid model/reasoning payload

## Phase 4: Validation, Docs, And Handoff

### Verification

- [x] service tests run
- [x] service build run
- [x] service lint run
- [x] web build/lint run if web changed
- [-] live Opus 4.6 smoke test complete
- [-] live Opus 4.7 smoke test complete
- [-] live GPT-5.4 smoke test complete
- [-] live GPT-5.5 smoke test complete

### Docs

- [x] `service/src/llm/llm.spec.md` updated
- [x] `service/src/llm/providers/providers.spec.md` updated
- [x] `service/src/agent/agent.spec.md` updated
- [x] `service/src/routes/routes.spec.md` updated
- [x] `web/src/lib/lib.spec.md` updated
- [x] `web/src/routes/$budId/budId.spec.md` updated
- [x] `service/.env.example` updated
- [x] `service/README.md` updated
- [x] `bud.spec.md` updated
- [x] mobile handoff notes captured

## Overall Progress

| Phase | Status | Notes |
| --- | --- | --- |
| 1 | Implemented | Catalog and reasoning policy are in place |
| 2 | Implemented | Providers support the new model set and request shapes |
| 3 | Implemented | `/api/models` and web consume catalog reasoning metadata |
| 4 | Automated Complete | Service/web validation passed; live smoke tests deferred until credentials/model access are available |

## Notes

- Keep this checklist current as soon as implementation or verification status changes.
- If provider docs/API behavior differs from the design assumptions, update the design and this plan before closing Phase 4.
