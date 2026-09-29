# Plan: GPT-6 Sol and Luna model catalog

## Context
Add the requested OpenAI models and make GPT-6 Luna the product default.
Related specs: [LLM](../service/src/llm/llm.spec.md), [providers](../service/src/llm/providers/providers.spec.md), [configuration](../service/src/src.spec.md), [routes](../service/src/routes/routes.spec.md).

Official model references verified September 29, 2026:
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)

## Design and acceptance
- Add exact IDs `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna` to the service catalog.
- Sol 6.1 supports low/medium/high/xhigh/max; Sol 6 and Luna also support none. Sol defaults to medium; Luna preserves Bud's high-effort default.
- Each model has a 1,050,000-token context and 128,000-token output limit. Preserve Bud's 272,000 usable-input policy and 128,000 output reserve.
- Move the global/OpenAI default and config/template fallback to GPT-6 Luna. Explicit environment overrides and saved thread selections retain precedence. Existing models and the separately pinned thread-title workload remain unchanged.
- Use the existing Responses API path, tool schema conversion, streaming and reasoning replay. No prompt or dependency changes.
- Web/mobile consume the authenticated catalog. Existing viewer authentication and Bud ownership checks remain; no new routes or DB writes.

## Specs to update
- service/service.spec.md
- service/src/src.spec.md
- service/src/llm/llm.spec.md
- service/src/llm/providers/providers.spec.md
- service/src/routes/routes.spec.md

## Impacted contracts
Catalog contents/default change; response shapes, SSE, daemon protocol, DB schema and agent tools are unchanged.

## Validation
Catalog/reasoning policy tests, authenticated model inventory tests, mocked streaming and non-streaming Responses tool requests, existing provider/context-budget tests, service TypeScript build. Live provider calls are not part of this validation.

## Rollout
Deploy/restart the service; refresh client model inventory. Remove or update an explicit DEFAULT_MODEL/OPENAI_MODEL override if the new built-in default is desired. No database migration, daemon release or mobile rebuild required. Existing threads retain their selected models.

## Result
Implemented. Focused suite: 68 passed, zero failures. `pnpm build` passed.

Validation command (from `service/`):
```sh
pnpm exec node --import tsx --test src/llm/model-catalog.test.ts src/llm/reasoning-policy.test.ts src/llm/providers/openai-tool-schema.test.ts src/llm/providers/providers.test.ts src/routes/models.test.ts src/agent/context-budget.test.ts
```
The first run exposed an incomplete update to the route test's expected catalog
(`ERR_ASSERTION`: actual contained the three new IDs, expected omitted them).
Corrected the expected inventory and removed duplicate mock-provider entries;
the rerun passed all 68 tests. No live API call or deployment performed.
