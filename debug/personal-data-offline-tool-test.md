# Debug: offline tool catalog expectation

Command from `service/`:
```
pnpm exec node --import tsx --test src/agent/personal-data-tools.test.ts src/agent/contracts.test.ts src/agent/model-runner.test.ts src/agent/conversation-loader.test.ts src/agent/transcript-writer.test.ts src/agent/agent-service.test.ts
```

51/52 passed. `model-runner.test.ts:358` expected only `ask_user_questions`, while the actual list also contains `contacts_search`, `contacts_history`, `location_context`, `timeline_query`. Stored-data queries are service-owned and deliberately work without a connected Bud. Update the expected catalog while retaining assertions that terminal and web-view tools are excluded offline. Re-run the affected agent suites.
