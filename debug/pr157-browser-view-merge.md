# Debug: PR #157 browser-view merge

## Environment
- Isolated macOS worktree for `browserview` at `838f635`, merging `main` at
  `bca60eb` on 2026-11-12.
- Validation uses the web package's mocked browser lifecycle tests and loopback
  WebSocket upstream; no database or LLM is required.

## Reproduction and observations
1. Fetch `main` and `browserview` and check out the PR head.
2. Run `git merge --no-commit --no-ff origin/main`.
3. Git reports `CONFLICT (content): Merge conflict in web/web.spec.md`.

The branches both extend the Vite proxy documentation: main documents the new
device-diagnostics route, while the PR documents browser-media WebSocket
forwarding and its regression test. `web/vite.config.ts` merges cleanly and
contains both routes. The browser visibility changes do not conflict.

The initial `git fetch origin main browserview` failed with
`git@github.com: Permission denied (publickey).` and
`fatal: Could not read from remote repository.` Fetching the same refs over
HTTPS with the existing GitHub CLI credential helper succeeded.

## Expected and proposed fix
- Retain both `/v1/diagnostics` documentation and `/ws` forwarding/test notes in
  [the web spec](../web/web.spec.md).
- Preserve the PR's passive media reconnect and exact private-override release
  behavior; review it against current main.
- Run the Vite proxy regression, browser desktop/mobile lifecycle tests, and web
  production build before publishing the resolution and merging the PR.

## Ownership and rollout
No new routes, data reads/writes, schema, or protocol changes are introduced by
the resolution. Existing service ownership and media-ticket authorization remain
authoritative. The PR changes the web client and local Vite forwarding; restart
Vite/reload web to adopt. No daemon upgrade or database migration is needed for
this PR beyond the existing requirements of main.

## Validation
- `git diff --check --cached` compares against the old PR head and reports
  pre-existing trailing blank lines brought in from main in
  `plan/location-agent-data/phase-13-agent-place-tools.md:82`,
  `phase-7-1-precise-confirmation.md:277`, `phase-7-2-service-decides.md:300`,
  `service/src/db/schema.ts:2206`, and
  `service/src/personal-data/personal-data.spec.md:873`
  (`new blank line at EOF`). `git diff origin/main --check` passes for the actual
  PR changes; the unrelated main content is preserved.
- `pnpm --dir web install --frozen-lockfile` installed dependencies but exited
  with `ERR_PNPM_IGNORED_BUILDS`,
  `Ignored build scripts: esbuild@0.25.12, esbuild@0.27.1`. This host runs pnpm
  12.5.1 and Node 22.23.2. Retrying with
  `pnpm --dir web install --frozen-lockfile --ignore-scripts` reports the same
  error. No lifecycle scripts were enabled. Installed platform binaries were
  sufficient for all validation below, without changing dependency policy.
- From `web/`, `pnpm test:dev-proxy`: 1/1 passed with a real HTTP 101 upgrade.
- From `web/`, `pnpm exec tsx --tsconfig tsconfig.app.json --test
  src/features/browser/state-feed.test.tsx src/features/browser/viewer.test.tsx
  src/features/browser/mobile-viewer.test.tsx
  src/features/browser/mobile-bridge.test.tsx`: 25/25 passed. Includes passive and
  private background/resume, pagehide/pageshow, detached callbacks, takeover,
  authorization loss, and native suspension.
- From `web/`, `pnpm build`: passed TypeScript and Vite production build; existing
  large-chunk warning only.
- Independent semantic review found no blocking issue: main has not changed the
  viewer source since this PR's merge base, and the resolved Vite config preserves
  both forwarding routes.
