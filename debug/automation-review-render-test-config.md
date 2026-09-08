# Debug: Automation review render test configuration

## Environment
Web package uses a references-only root tsconfig and automatic JSX runtime in tsconfig.app.json.

## Repro Steps
From web: `pnpm exec tsx --test src/components/automation-proposal-summary.test.ts`.

## Observed
Both render tests failed with `ReferenceError: React is not defined` at AutomationProposalSummary. The web build passed.

## Hypothesis and Fix
The standalone tsx runner used the root configuration and classic JSX. Run these render tests with `--tsconfig tsconfig.app.json`. Use a `.test.tsx` filename to distinguish JSX-dependent render tests from the ordinary strip-types `.test.ts` suite. No production runtime change is needed.

Follow-up build: `pnpm build` failed with TS2307 for `node:test` and `node:assert/strict` in the `.test.tsx` file. The browser-only tsconfig excluded `.test.ts` but not `.test.tsx`. Extend that existing exclusion to render tests and add a discoverable `test:render` package script using the app JSX configuration.
