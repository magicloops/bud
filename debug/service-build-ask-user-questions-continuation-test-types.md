# Debug: service-build-ask-user-questions-continuation-test-types

## Environment
- Workspace: `/Users/adam/bud`
- Package: `service`
- Command run from repo root with `pnpm --dir /Users/adam/bud/service`
- LLM mode: mocked/fake provider in integration tests

## Repro Steps
1. Run:
   ```bash
   pnpm --dir /Users/adam/bud/service build
   ```

## Observed
```text
> @bud/service@0.0.1 build /Users/adam/bud/service
> tsc --project tsconfig.json

src/agent/ask-user-questions-continuation.integration.test.ts(321,30): error TS2339: Property 'status' does not exist on type 'never'.
src/agent/ask-user-questions-continuation.integration.test.ts(322,27): error TS2339: Property 'updatedAt' does not exist on type 'never'.
 ELIFECYCLE  Command failed with exit code 2.
```

## Expected
- `pnpm --dir /Users/adam/bud/service build` should complete without TypeScript errors.

## Hypotheses
- The local variable used to capture `markPendingQuestionRequestsCanceled(...)` calls is narrowed to `never` after a callback assignment pattern in the continuation integration test.
- The runtime behavior is covered by the passing focused test suite; this appears to be a test type-checking issue.

## Proposed Fix
- Refactor the continuation integration test to avoid callback-captured nullable narrowing for the cancellation record, or assert through a typed array/spy helper that TypeScript can narrow.
- Spec files affected: none expected beyond the existing Phase 5 test/spec updates.
