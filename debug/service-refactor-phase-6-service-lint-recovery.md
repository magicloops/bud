# Debug: service-refactor-phase-6-service-lint-recovery

## Environment
- OS / arch / versions: macOS local dev workstation, workspace at `/Users/adam/bud`
- DB connection style: local dev database already updated via `pnpm db:push`
- LLM mode (real/mocked): not relevant to the failing lint step

## Repro Steps
1. Run `pnpm --dir /Users/adam/bud/service lint`

## Observed
- The lint step failed with `43` errors and `22` warnings after the service refactor closure pass.
- The error-level findings clustered around:
  - base `no-unused-vars` firing on TypeScript contract signatures and type-only parameters
  - base `no-undef` firing on TypeScript type globals such as `BodyInit`, `HeadersInit`, and `NodeJS`
  - a smaller set of refactor-touched files that needed confirmation they were real unused-value leftovers rather than config noise

Representative failures:

```text
/Users/adam/bud/service/src/auth/auth.ts
  149:68  error  'BodyInit' is not defined     no-undef
  182:21  error  'HeadersInit' is not defined  no-undef

/Users/adam/bud/service/src/llm/provider.ts
  44:5   error  'messages' is defined but never used  no-unused-vars
  45:5   error  'tools' is defined but never used     no-unused-vars

/Users/adam/bud/service/src/runtime/terminal/request-dispatcher.ts
  108:49  error  'assessment' is defined but never used  no-unused-vars

/Users/adam/bud/service/src/runtime/terminal/idle-monitor.ts
  13:30  error  'NodeJS' is not defined  no-undef
```

## Expected
- `pnpm --dir /Users/adam/bud/service lint` should pass with TypeScript files checked by TypeScript-aware lint rules rather than base JavaScript rules that do not understand type-only syntax.

## Hypotheses
- `service/eslint.config.js` still uses `eslint.configs.recommended` plus only a couple of TypeScript warning rules, but it never disables base `no-unused-vars` / `no-undef` for `src/**/*.ts`.
- That leaves interface-heavy and type-heavy files producing false-positive errors even when the code is valid and `tsc` passes.
- The right first fix is at the ESLint ownership boundary, not scattered per-file suppressions.

## Proposed Fix
- In `service/eslint.config.js`, disable base `no-unused-vars` and `no-undef` for TypeScript files.
- Enable `@typescript-eslint/no-unused-vars` as the authoritative unused-vars rule for `src/**/*.ts`.
- Re-run `pnpm --dir /Users/adam/bud/service lint`.
- Only touch individual source files if real unused runtime values remain after the config fix.
