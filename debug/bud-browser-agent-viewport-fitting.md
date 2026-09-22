# Debug: agent-owned pane fitting

## Environment and reproduction
Local web/service and macOS Chrome for Testing. Open a browser pane while the
agent owns the browser. Previously fitting only ran after Take control.

## Findings and fix
Resize used the private input coordinator. Added capability-gated passive fitting
without invocation/epoch/sequence mutation. Reuse the daemon page lock; preserve
media on passive errors. See [plan](../plan/bud-owned-browser/agent-viewport-fitting.md).

## Validation setup corrections
- `python /tmp/implement-passive-fit.py` failed: `zsh:139: command not found: python`.
  Used the installed `python3`; no partial edits ran before that correction.
- From web, `pnpm exec tsx --test src/features/browser/viewer.test.tsx` failed with
  `ReferenceError: React is not defined`. The package render tests require
  `--tsconfig tsconfig.app.json` for automatic JSX; corrected invocation passes.

## Evidence
Service control tests and mounted web viewer tests pass. Service/web builds pass
(web retains its existing chunk-size warning). Real Chrome manager tests pass with
BUD_BROWSER_EXECUTABLE set to the configured Chrome for Testing installation,
including private lease/capture/return and passive resize/agent continuation.
Manual pane/agent acceptance remains to run after restarting the user's daemon.

- Targeted ESLint initially rejected the test fake's `client = this` capture
  (`@typescript-eslint/no-this-alias`); use the existing clients-array fixture
  pattern instead.
- Service readiness passes directly on localhost:3000; the local HTTPS
  `/readyz` path currently falls through to Vite, so it is not a service health probe.
