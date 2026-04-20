# Phase 8: Web Lint Recovery And Final Closeout

**Status**: Complete

## Objective

Finish the service refactor closure pass after Phase 7 proved that:

- `service` build/lint is now green
- `web` build is green
- `web` lint still blocks final closeout

This phase exists to scope the remaining frontend lint work explicitly instead of leaving the refactor in a vague "almost done" state.

## Outcome

Phase 8 is complete.

The implemented closure work:

- split the shared auth-session, bud-status, and layout modules into hook/context files plus dedicated provider files so `react-refresh/only-export-components` passes without suppression
- removed the dead `_bud` and terminal-disconnect locals from the Bud/thread routes
- rewired the model-loader effects to use functional state updates instead of captured `selectedModel`
- made the thread-title SSE callback depend explicitly on the loader/context values it uses
- reran the full final `service` / `web` build-lint matrix and closed the refactor docs/checklists

## Scope

### In scope

- the current `pnpm --dir /Users/adam/bud/web lint` failures and warnings
- any small supporting file moves needed to satisfy React Fast Refresh constraints
- the final rerun of the full `service` / `web` verification pass
- final refactor closeout docs/checklists

### Out of scope

- new frontend feature work
- broad UI redesign
- unrelated frontend cleanup outside the current lint blockers

## Current Findings

The latest closure pass succeeded through:

- `pnpm --dir /Users/adam/bud/service build`
- `pnpm --dir /Users/adam/bud/service lint`
- `pnpm --dir /Users/adam/bud/web build`

and then stopped at:

```bash
pnpm --dir /Users/adam/bud/web lint
```

with these remaining findings:

### 1. React Fast Refresh context-file violations

Files:

- `web/src/contexts/auth-session-context.tsx`
- `web/src/contexts/bud-status-context.tsx`
- `web/src/contexts/layout-context.tsx`

Rule:

- `react-refresh/only-export-components`

Current pattern:

- each file exports both a provider component and a non-component hook from the same module

Likely fix directions:

- split the hooks into dedicated files, or
- split the raw contexts/constants out so the component-export files satisfy the rule cleanly

The preferred path is structural rather than suppressive, because these are stable shared app-shell modules and the rule is pointing at a real Fast Refresh convention.

### 2. Small route-level unused locals

Files:

- `web/src/routes/$budId.tsx`
- `web/src/routes/$budId/$threadId.tsx`

Current findings:

- unused `_bud` loader binding in `/$budId`
- unused `_terminalDisconnectTime` state value in `/$budId/$threadId`

These look like genuine local cleanup, not config problems.

### 3. Hook dependency warnings in the thread/new-thread routes

Files:

- `web/src/routes/$budId/$threadId.tsx`
- `web/src/routes/$budId/new.tsx`

Current findings:

- missing `selectedModel` dependency in model-loading effects
- missing `initialThread` / `upsertThreadSummary` dependencies in a callback path inside the thread route

These need deliberate handling rather than silence-by-default. The fix should preserve the intended UX semantics while making the dependency model explicit.

## Proposed Work

### 1. Normalize the context-module shape for Fast Refresh

Refactor the three context modules so their exports satisfy the current React Refresh rule without disabling it.

Expected direction:

- keep provider components in component-export files
- move shared hooks and/or context objects into adjacent helper modules when needed
- update any imports in routes/components that consume those hooks

### 2. Remove the genuine dead locals

Clean up the unused values in:

- `web/src/routes/$budId.tsx`
- `web/src/routes/$budId/$threadId.tsx`

This should be a small, behavior-preserving edit.

### 3. Resolve hook dependency warnings deliberately

For the route effects/callbacks:

- either include the missing dependencies and prove the resulting behavior is still correct
- or restructure the code so the intended stable dependency surface is explicit

Do not solve this with blanket rule suppression unless a specific hook truly needs a documented exception.

### 4. Re-run the final package verification pass

Required commands after the web fixes:

```bash
pnpm --dir /Users/adam/bud/service build
pnpm --dir /Users/adam/bud/service lint
pnpm --dir /Users/adam/bud/web build
pnpm --dir /Users/adam/bud/web lint
```

If the web-lint fix requires file moves in shared app-shell modules, rerun only the smallest additional checks needed beyond this matrix.

### 5. Mark the refactor closed

Once the full matrix is green:

- update `progress-checklist.md`
- update `implementation-spec.md` status/definition-of-done language
- update any affected `web` specs if the context-module structure changes
- mark the service refactor closed in the root documentation index

## Expected File Areas

- `web/src/contexts/auth-session-context.tsx`
- `web/src/contexts/bud-status-context.tsx`
- `web/src/contexts/layout-context.tsx`
- `web/src/routes/$budId.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/routes/$budId/new.tsx`
- `web/src/contexts/contexts.spec.md` if files move
- `web/src/routes/routes.spec.md` if route responsibilities change
- `plan/refactor-service/progress-checklist.md`
- `plan/refactor-service/implementation-spec.md`
- `plan/refactor-service/refactor-service.spec.md`
- `bud.spec.md`

## Exit Criteria

- `pnpm --dir /Users/adam/bud/web lint` passes
- the full final `service` / `web` build-lint matrix passes in one closure run
- the service refactor docs/checklists are marked closed with no remaining ambiguity

## Verification

The final closure pass succeeded with:

```bash
pnpm --dir /Users/adam/bud/service build
pnpm --dir /Users/adam/bud/service lint
pnpm --dir /Users/adam/bud/web build
pnpm --dir /Users/adam/bud/web lint
```
