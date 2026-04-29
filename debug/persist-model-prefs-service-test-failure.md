# Debug: Persist Model Preferences Service Test Failure

## Environment
- OS / arch / versions: local macOS workspace, service package tests through `tsx`
- DB connection style: local `pnpm db:push` had already applied the thread preference columns
- LLM mode: mocked providers in route/unit tests

## Repro Steps
1. From repo root, run:
   ```bash
   pnpm --dir /Users/adam/bud/service test
   ```

## Observed
- Command exited with code `1`.
- Two subtests failed:

```text
not ok 63 - resolveEffectiveModelSelection rejects unsupported explicit reasoning
error: The error is expected to be an instance of "InvalidReasoningEffortError". Received "InvalidModelSelectionError"
Error message:
Model is not available: gpt-5.5
```

```text
not ok 103 - GET /api/models returns catalog-backed reasoning metadata
error: Expected values to be strictly equal:
null !== 'gpt-5.5'
```

## Expected
- Resolver tests should validate unsupported explicit reasoning without requiring a configured provider when `validateAvailability: false`.
- `/api/models` should return `service_default_model: "gpt-5.5"`, `default_model: "gpt-5.5"`, and `default_reasoning_effort: "low"` in the mocked OpenAI+Anthropic provider setup.

## Hypotheses
- The resolver's catalog-only path returns `null` for unsupported reasoning, which the explicit-selection path converts to `InvalidModelSelectionError` instead of preserving `InvalidReasoningEffortError`.
- The `/api/models` test may run after another test mutates `config.defaultModel` or provider registry state, causing the route's service-default resolver to fall into its fallback branch.

## Proposed Fix
- Adjust `resolveCandidateOrThrow(..., validateAvailability: false)` to distinguish "known catalog model with unsupported reasoning" from "unknown model".
- Make the `/api/models` default test isolate `config.defaultModel` and provider registry state before asserting the service default fields.
- Spec files affected: none expected beyond the already-updated model-preference specs unless behavior changes.

## Resolution
- Implemented the catalog-only explicit-selection path so a known catalog model with unsupported reasoning throws `InvalidReasoningEffortError` instead of `InvalidModelSelectionError`.
- Isolated `models.test.ts` from local `.env` `DEFAULT_MODEL` overrides by temporarily setting `config.defaultModel = "gpt-5.5"` for the route test.
- Re-ran:
  ```bash
  pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/llm/reasoning-policy.test.ts src/routes/models.test.ts
  pnpm --dir /Users/adam/bud/service test
  git diff --check
  ```
- All three commands passed after the fix.
