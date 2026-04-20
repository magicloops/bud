# Phase 6: Service Lint Recovery

## Objective

Restore a passing `pnpm --dir /Users/adam/bud/service lint` result after the refactor closure pass exposed a mix of:

- TypeScript-specific ESLint rule/config mismatch
- real unused-value fallout from the ownership splits
- Better Auth bridge typing/global gaps

This phase is specifically about getting the `service` package back to a trustworthy lint baseline without papering over real problems.

## Scope

### In scope

- `service/eslint.config.js` rule ownership and globals for TypeScript files
- error-level lint findings currently blocking `service` lint
- narrow code cleanup in refactor-touched files where parameters, state, or helper signatures are now unused
- explicit typing cleanup for fetch/DOM-related globals used from Node in `service/src/auth/auth.ts`

### Out of scope

- `web/` lint cleanup
- warning-only cleanup unless it is effectively free while fixing an error
- new feature work
- broad file churn unrelated to the failing lint step

## Current Findings

The latest closure attempt failed on:

```bash
pnpm --dir /Users/adam/bud/service lint
```

with `43` errors and `22` warnings.

The error-level findings cluster into four groups:

### 1. TypeScript lint rule ownership is wrong for contract-heavy files

`service/eslint.config.js` currently leaves the base `no-unused-vars` rule active for TypeScript files while only adding a couple of TypeScript-specific warning rules.

That makes contract-heavy `.ts` files fail on type-only or interface-style signatures that should be owned by `@typescript-eslint/no-unused-vars`, including:

- `service/src/llm/provider.ts`
- `service/src/runtime/terminal/request-dispatcher.ts`
- `service/src/runtime/terminal/output-store.ts`
- `service/src/runtime/terminal/idle-monitor.ts`

This is the main structural problem. If it is not fixed first, the repo will keep reintroducing noisy false positives in exactly the kinds of typed ownership boundaries this refactor created.

### 2. There is still real dead-code fallout from the refactor

Some error-level findings appear to be genuine leftovers from the runtime split rather than config artifacts, including:

- `service/src/agent/terminal-tool-executor.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/terminal/context-sync-service.ts`

These should be treated as real cleanup work: either remove the unused parameter/state, or prove it still belongs and thread it back into a live path.

### 3. The Better Auth bridge needs explicit runtime/type cleanup

`service/src/auth/auth.ts` is failing for two different reasons:

- unused helper arguments
- missing global typing for `BodyInit` / `HeadersInit`

This should be fixed explicitly rather than relying on ambient globals by accident. The implementation should choose one of:

- explicit type imports / local aliases, or
- a deliberate ESLint global environment decision for the service package

and keep the result consistent across the file.

### 4. Node-specific timer typing needs to be made explicit

`service/src/runtime/terminal/idle-monitor.ts` currently trips `NodeJS` global handling during lint.

That needs one deliberate fix direction:

- import/use the supported Node timer type explicitly, or
- align lint globals/parser config so the existing type surface is valid

Do not leave this as an implicit ambient-type accident.

## Proposed Work

### 1. Normalize ESLint rule ownership for TypeScript files

Update `service/eslint.config.js` so TypeScript files are checked by TypeScript-aware rules instead of the base JavaScript unused-vars rule.

Expected direction:

- disable base `no-unused-vars` for `src/**/*.ts`
- enable/configure `@typescript-eslint/no-unused-vars`
- keep the change narrow to the `service` package

This should reduce false positives on interface/contract signatures without weakening real unused-value detection in runtime code.

### 2. Clear the real error-producing files by ownership area

#### Contract/type-only surfaces

Files:

- `service/src/llm/provider.ts`
- `service/src/runtime/terminal/request-dispatcher.ts`
- `service/src/runtime/terminal/output-store.ts`
- `service/src/runtime/terminal/idle-monitor.ts`

Goal:

- preserve readable contracts
- avoid blanket file-level disables
- use the config fix first, then only add local naming/annotations where a file still needs them

#### Refactor leftovers

Files:

- `service/src/agent/terminal-tool-executor.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/terminal/context-sync-service.ts`

Goal:

- remove unused constructor parameters, callback args, or state snapshots that no longer carry behavior
- avoid keeping dead ownership seams around just to satisfy old signatures

#### Better Auth bridge

File:

- `service/src/auth/auth.ts`

Goal:

- remove dead helper parameters
- make fetch/body/header typing explicit and lint-clean in Node
- keep the auth bridge understandable instead of layering suppressions over it

### 3. Keep the fix narrow and auditable

Guardrails for implementation:

- no package-wide rule downgrades beyond the TypeScript unused-vars ownership fix
- no broad `eslint-disable` banners unless a very small contract surface truly needs one and the reason is documented inline
- no unrelated style churn

### 4. Re-validate the package baseline

Minimum validation for this phase:

- `pnpm --dir /Users/adam/bud/service lint`

Recommended follow-up when config or type surfaces move:

- `pnpm --dir /Users/adam/bud/service build`

## Expected File Areas

- `service/eslint.config.js`
- `service/src/auth/auth.ts`
- `service/src/llm/provider.ts`
- `service/src/agent/terminal-tool-executor.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/runtime/terminal/request-dispatcher.ts`
- `service/src/runtime/terminal/output-store.ts`
- `service/src/runtime/terminal/idle-monitor.ts`
- `service/src/terminal/context-sync-service.ts`
- affected service specs if file responsibilities change materially

## Exit Criteria

- `pnpm --dir /Users/adam/bud/service lint` exits successfully
- the TypeScript lint-rule ownership problem is fixed explicitly in `service/eslint.config.js`
- real unused-value fallout from the refactor is removed rather than hidden
- no broad suppressions are added just to force a green run
