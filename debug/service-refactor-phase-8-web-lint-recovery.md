# Debug: service-refactor-phase-8-web-lint-recovery

## Environment
- OS / arch / versions: macOS local dev workstation, workspace at `/Users/adam/bud`
- DB connection style: local dev database already updated via `pnpm db:push`
- LLM mode (real/mocked): not relevant to the failing frontend lint step

## Repro Steps
1. Run `pnpm --dir /Users/adam/bud/web lint`

## Observed
- The final service-refactor closure pass cleared `service` build/lint and `web` build, but stopped on `web` lint.
- The remaining findings clustered into three small frontend cleanup buckets:
  - `react-refresh/only-export-components` on the shared context modules because each file exported both a provider component and a consumer hook
  - two genuine unused locals in the Bud/thread routes
  - two `react-hooks/exhaustive-deps` warnings caused by captured state or loader values in long-lived route callbacks/effects

Representative failures:

```text
/Users/adam/bud/web/src/contexts/auth-session-context.tsx
  38:17  error  Fast refresh only works when a file only exports components  react-refresh/only-export-components

/Users/adam/bud/web/src/routes/$budId/$threadId.tsx
  430:6   warning  React Hook useEffect has a missing dependency: 'selectedModel'  react-hooks/exhaustive-deps
  1348:6  warning  React Hook useCallback has missing dependencies: 'initialThread' and 'upsertThreadSummary'  react-hooks/exhaustive-deps
```

## Expected
- `pnpm --dir /Users/adam/bud/web lint` should pass without broad suppressions, and the service refactor should be able to close on a full green service/web build-lint matrix.

## Hypotheses
- The context modules need a structural split between component exports and hook/context exports to satisfy the stock Vite Fast Refresh rule cleanly.
- The route warnings are real local cleanup, not config problems.
- The model-loader effects should use functional state updates so they do not depend on captured `selectedModel`, and the thread-title SSE callback should make its loader/context dependency explicit.

## Proposed Fix
- Split the auth-session, bud-status, and layout providers into dedicated provider modules and leave the existing context files as hook/context-only modules.
- Remove the dead loader/state locals from the Bud and thread routes.
- Restructure the model-loader effects and thread-title stream callback so the hook dependency graph is explicit.
- Re-run `pnpm --dir /Users/adam/bud/web lint`, then the final full service/web build-lint matrix if it succeeds.
