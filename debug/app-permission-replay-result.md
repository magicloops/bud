# Debug: App permission result omitted during replay

## Environment and reproduction

Local PostgreSQL, mocked provider ledger. Run from `service/`:
`BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/agent/invocation-app-data.test.ts`.

## Observed

The test passed its call/result count check, but the loader logged
`repaired orphaned tool calls in replay` with `injectedResults: 1`.
The saved permission result was absent from the loader's recognized tool names.
Its generic repair substituted an interrupted result for the approved decision.

## Expected and fix

Replay the stored decision exactly once, without generic repair. Recognize the
permission result separately from executable directives. Same-provider calls
retain their original ledger arguments; canonical fallback uses the public
request metadata, without restoring private delivery material. Strengthen the
PostgreSQL assertion to require the actual approved payload and no repair source.

Relevant spec: `service/src/agent/agent.spec.md`.
