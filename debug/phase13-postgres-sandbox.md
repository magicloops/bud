# Debug: Phase 13 PostgreSQL test sandbox access

Command from service/:
`BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/agent/invocation-automation-proposal.test.ts src/agent/automation-tools.test.ts src/llm/providers/openai-tool-schema.test.ts src/personal-data/automation-proposal-contracts.test.ts > /tmp/bud-phase13-tests.log 2>&1`

Initial result: nine pass, one PostgreSQL fixture fails with `AggregateError`,
code `EPERM`, at pg-pool/index.js:45 and the fixture's cleanup query.
The sandbox denied localhost PostgreSQL access. Repeating the same command with
approved escalation passed all ten tests. No product fix required for this failure.
