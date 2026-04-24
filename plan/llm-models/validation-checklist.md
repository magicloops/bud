# LLM Models Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Service Catalog And Reasoning Policy

### Catalog Invariants

- [x] every product ID is unique
- [x] every catalog entry maps to `openai` or `anthropic`
- [x] exactly one global default exists
- [x] global default is `claude-opus-4-6`
- [x] GPT-5.5 is in the OpenAI catalog entries
- [x] catalog entries do not include a public `available` flag

### Reasoning Policy

- [x] omitted reasoning for Opus 4.6 resolves to `high`
- [x] omitted reasoning for Sonnet 4.6 resolves to `medium`
- [x] omitted reasoning for Opus 4.7 resolves to `xhigh`
- [x] omitted reasoning for GPT-5.4 resolves to `none`
- [x] Opus 4.6 accepts `max`
- [x] Opus 4.6 rejects `xhigh`
- [x] Opus 4.7 accepts `xhigh`
- [x] GPT-5.4 accepts `xhigh`
- [x] unsupported effort error includes supported values

## Phase 2: Provider Adapters And Model Rollout

### OpenAI Request Shapes

- [x] GPT-5.4 with `xhigh` sends expected `reasoning.effort`
- [ ] GPT-5.4 mini with `xhigh` sends expected `reasoning.effort`
- [ ] GPT-5.4 nano with `xhigh` sends expected `reasoning.effort`
- [x] GPT-5.5 routes through OpenAI provider
- [x] `none` effort omits/disables reasoning as intended

### Anthropic Request Shapes

- [x] Opus 4.6 with `max` sends `output_config.effort = "max"`
- [ ] Sonnet 4.6 default sends selected default effort
- [x] Opus 4.7 with `xhigh` sends `output_config.effort = "xhigh"`
- [x] Opus 4.7 sends adaptive thinking
- [x] Opus 4.7 does not send `budget_tokens`
- [x] Haiku 4.5 follows selected reasoning behavior
- [x] any SDK casts are local to the Anthropic provider

## Phase 3: API Contract And Client Adoption

### `/api/models`

- [ ] Anthropic-only provider config returns Anthropic product models
- [ ] OpenAI-only provider config returns OpenAI product models
- [x] both providers configured returns both families
- [x] response includes `default_model`
- [x] response includes `reasoning.kind`
- [x] response includes `reasoning.levels`
- [x] response includes `reasoning.default_level`
- [x] response does not include `available`
- [x] response includes GPT-5.5 when OpenAI is configured

### Message Creation

- [ ] supported model/reasoning combination starts an agent turn
- [ ] unsupported model/reasoning combination returns 400
- [ ] unsupported effort failure happens before provider invocation
- [ ] error body includes selected model and supported values

### Web

- [ ] initial composer state uses selected model default reasoning
- [ ] changing to Opus 4.7 exposes `xhigh` and `max`
- [ ] changing to Opus 4.6 removes `xhigh`
- [ ] changing from Opus 4.7 `xhigh` to Opus 4.6 resets to Opus 4.6 default
- [ ] changing to GPT-5.4 exposes `none` and `xhigh`
- [x] submitted payload uses `reasoning_effort`

## Phase 4: Live Smoke And Docs

### Automated Verification

- [x] `pnpm --dir service test`
- [x] `pnpm --dir service build`
- [x] `pnpm --dir service lint`
- [x] `pnpm --dir web build`
- [x] `pnpm --dir web lint`
- [x] `git diff --check`

### Live Smoke

- [-] `claude-opus-4-6` with `max` completes a simple turn
- [-] `claude-sonnet-4-6` with default effort completes a simple turn
- [-] `claude-opus-4-7` with `xhigh` completes a simple turn
- [-] `claude-haiku-4-5` completes according to selected behavior
- [-] `gpt-5.4` with `xhigh` completes a simple turn
- [-] `gpt-5.4-mini` with `xhigh` completes a simple turn
- [-] `gpt-5.4-nano` with `xhigh` completes if account access allows it
- [-] `gpt-5.5` completes a simple turn

### Docs / Spec Alignment

- [x] `service/src/llm/llm.spec.md` describes catalog ownership
- [x] `service/src/llm/providers/providers.spec.md` describes provider-specific lowering
- [x] `service/src/agent/agent.spec.md` describes model-specific reasoning validation
- [x] `service/src/routes/routes.spec.md` describes `/api/models` reasoning metadata
- [x] `web/src/lib/lib.spec.md` describes catalog-backed model helpers
- [x] `web/src/routes/$budId/budId.spec.md` describes composer model/reasoning state
- [x] `service/.env.example` defaults to `claude-opus-4-6`
- [x] `service/README.md` reflects new model defaults
- [x] `bud.spec.md` links this plan
- [x] mobile handoff notes state there is no compatibility window for `xhigh`/`max`

## Notes

- Live smoke tests require real provider credentials and may depend on account model access; they were not run during automated validation.
- If a build/run command fails, capture the exact command and error output and stop for human guidance.
