# Debug: service-refactor-phase-7-closeout

## Environment
- OS / arch / versions: macOS local dev workstation, workspace at `/Users/adam/bud`
- DB connection style: local development DB already validated with `pnpm db:push`
- LLM mode (real/mocked): not relevant to the warning-only lint cleanup

## Repro Steps
1. Run `pnpm --dir /Users/adam/bud/service lint` after the Phase 6 ESLint ownership fix

## Observed
- The blocking lint errors were gone, but the command still reported `24` warnings.
- The warnings fell into three small closure buckets:
  - `@typescript-eslint/no-explicit-any` in tests and one Better Auth metadata helper cast
  - `@typescript-eslint/explicit-module-boundary-types` on exported/shared helpers
  - two stale `eslint-disable` comments left behind after switching TypeScript files to `@typescript-eslint/no-unused-vars`

## Expected
- The service refactor should close with an explicit lint posture rather than relying on the fact that warnings do not fail the script.
- The final `service` and `web` build/lint pass should run from a clean `service` lint baseline.

## Hypotheses
- Most remaining warnings can be removed with narrow type assertions, explicit helper return types, and cleanup of stale suppression comments.
- No broader lint-rule changes should be needed beyond the Phase 6 config fix.

## Proposed Fix
- Replace remaining `any` test/internal casts with targeted `Reflect.get(...)` or `unknown`-based assertions.
- Add explicit return types to the shared exported helpers currently flagged by `explicit-module-boundary-types`.
- Remove the stale `eslint-disable` comments in the SSE/event-bus runtime files.
- Re-run:
  - `pnpm --dir /Users/adam/bud/service build`
  - `pnpm --dir /Users/adam/bud/service lint`
  - `pnpm --dir /Users/adam/bud/web build`
  - `pnpm --dir /Users/adam/bud/web lint`
