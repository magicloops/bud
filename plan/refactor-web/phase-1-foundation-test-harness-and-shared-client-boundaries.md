# Phase 1: Foundation, Test Harness, And Shared Client Boundaries

## Objective

Create the minimum safe base for the web refactor by:

- adding a web test harness
- extracting the lowest-risk shared helpers out of the current mixed modules
- fixing the cheapest correctness issues that are already well understood

This phase should reduce immediate risk without forcing the deeper architectural decisions too early.

## Scope

### In scope

- add a web test runner and initial coverage
- extract pure/shared browser helpers from `web/src/lib/api.ts`
- extract duplicated model-loading logic into a shared hook or module
- fix the `system` theme change bug
- define shared helper locations for route auth redirects, time formatting, and session-state formatting

### Out of scope

- central auth-shell removal of duplicated route guards
- full thread-route decomposition
- large Bud-layout changes
- render-path virtualization

## Proposed Work

### 1. Add the web test harness first

Introduce the minimum test baseline needed for the rest of the refactor.

Recommended coverage targets:

- transcript identity/reconciliation helpers
- auth redirect path normalization
- route-auth helper behavior
- model-selection defaulting logic
- theme `system` mode behavior

The exact tool choice can be settled during implementation, but the outcome needs:

- a `test` script in `web/package.json`
- package-local test execution from `web/`
- lightweight DOM-capable coverage for React hooks/components where needed

Completed first slice:

- `web/package.json` now exposes a runnable `test` / `test:watch` command using Node's built-in test runner with `--experimental-strip-types`
- the initial harness intentionally targets pure helper seams so coverage can run without adding a blocked browser-test dependency mid-refactor
- colocated tests now cover auth redirect normalization plus extracted transcript/message reconciliation and shared stream-timing helpers

Remaining in this area:

- add a DOM-capable browser test dependency when the repo is ready for hook/component-level coverage
- extend beyond pure-helper tests into the extracted thread runtime hooks and UI surfaces

### 2. Split low-risk helpers out of `web/src/lib/api.ts`

Initial extractions should focus on clean ownership, not transport redesign.

Recommended first split:

- `web/src/lib/auth/redirect.ts`
- `web/src/lib/transport/url.ts`
- `web/src/lib/terminal/decode.ts`
- `web/src/lib/messages/client-id.ts`
- `web/src/lib/api-types.ts`

The goal is to shrink `api.ts` before the route and thread work starts.

### 3. Create shared helpers for repeated UI/domain formatting

The current code repeats logic that should be shared:

- relative time formatting
- session-state labels/colors
- model loading/default selection

Extract these helpers now so later phases reuse them instead of duplicating them again.

### 4. Fix cheap, isolated correctness issues

Phase 1 should include:

- subscribe to `prefers-color-scheme` changes in `ThemeProvider`
- add explicit user-visible error handling pattern for thread delete failures or, at minimum, extract the common mutation-feedback structure that later phases can adopt

### 5. Document the target test boundaries

Before Phase 2 begins, the repo should have an explicit record of which browser behaviors are considered high-risk and must stay covered:

- auth redirect behavior
- transcript reconciliation
- agent stream message state transitions
- terminal reconnect/recovery state transitions

## Expected File Areas

- `web/package.json`
- `web/src/lib/api.ts`
- `web/src/lib/`
- `web/src/components/theme-provider.tsx`
- `web/src/components/workbench/thread-panel.tsx`
- new test files under `web/src/` or a dedicated web test folder

## Testing Strategy

### Automated

- add the initial `web` unit/integration test harness
- cover the newly extracted pure helpers first
- cover at least one user-visible bug fix in this phase

### Manual

- verify theme changes when toggling the OS theme while Bud is open
- verify thread delete failures are surfaced through the UI path chosen in implementation

## Exit Criteria

- the web package has a runnable test command
- `api.ts` is smaller and no longer owns all low-risk helpers
- model selection/defaulting logic is shared
- the `system` theme bug is fixed
- the refactor has an initial automated safety net for later phases
