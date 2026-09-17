# Debug: Provider-anchored context validation

## Environment
Local macOS, service TypeScript build and Node tests; no production DB changes.
Related: [implementation plan](../plan/provider-anchored-context-accounting.md).

## Observed during implementation
- `pnpm --dir service build` initially reported a missing `BrowserAgentContext.signal`
  and snapshot tests importing the removed timestamp-based anchor type / `deltaMessages`.
  Added the availability-check signal and replaced obsolete tests with shared
  active/durable accounting assertions.
- A subsequent build found the new test fixture used `input_schema` instead of
  canonical `parameters`; corrected the fixture.
- The focused integration test command (agent-service, model-runner,
  conversation-loader, automation-agent-loop, model-context and agent-question-response)
  initially passed 54/56. The ledger assertion needed the newly persisted baseline.
  The other failure is an existing system-prompt assertion banning the word
  `readiness` globally, now also used by the browser guidance. Context accounting
  does not change the system prompt.

## Validation
Service and web builds pass; 79 focused service tests and 13 web meter tests pass.
`git diff --check` passes. The broader prompt-vocabulary failure was confirmed
against the unchanged HEAD prompt (browser guidance already uses `readiness`).
Real browsing/restart validation remains a documented follow-up in the plan.

## Prompt-test cleanup
The user requested removal of the retired terminal-vocabulary test. Removed the
entire migration-era prompt string assertion block, including its required-word
checks; behavioral loader/tool coverage remains unchanged. The prompt is unchanged.
Validation: `pnpm exec node --import tsx --test src/agent/conversation-loader.test.ts`
passes after removal; `git diff --check` is clean.
