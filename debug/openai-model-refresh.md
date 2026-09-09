# Debug: OpenAI model refresh

September 9, 2026. Catalog retirement and Astra addition per plan/openai-model-refresh.md.

Adapter reasoning detection uses a gpt-5 prefix and would drop Astra reasoning configuration. Provider also accepts every gpt-* model through fallback, bypassing catalog retirement. Fix both using catalog metadata.

Production inventory attempt: `node /tmp/bud-prod-read.cjs` with an information_schema model-column query returned `{"failed":true}` (credentials never printed). Production inventory remains a rollout check; do not mutate historical model attribution or silently retarget automation revisions.

Validation failures: the focused `pnpm --dir service exec node --import tsx --test` run reported `272000 !== 1000` in context-budget.test.ts after the fixture moved to Sol. The synthetic hard-window test now explicitly omits the catalog usable cap. Additional `src/agent/agent-service.test.ts` run reported `unknown !== available`: its active compaction fixture still selected retired GPT-5.5. Switched that active fixture to Astra. Both suites passed on rerun. Service, web and iOS simulator builds succeeded.

The first ad-hoc live continuation probe returned HTTP 400: `A function call output without a call_id requires a name.` The probe used `toolUseId` instead of the canonical `tool_use_id`; correcting the probe made the tool round trip pass. No product adapter change was required for this error.
