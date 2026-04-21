# Validation Checklist: Web Architecture Refactor

Manual validation completed on 2026-04-21.

Notes from the closeout pass:

- the false empty-message submit path was fixed by validating against submitted form data rather than stale route-local state
- direct local thread deletion was fixed by expanding the service CORS preflight method allowlist for trusted browser origins
- deeper automated browser/runtime hardening is intentionally deferred to the follow-up plan in `design/web-refactor-test-hardening.md`

## Auth / Session Shell

- [x] anonymous access to `/` redirects correctly to `/login`
- [x] authenticated access to `/`, `/$budId`, and `/settings` works without duplicate redirect loops
- [x] root current-user resolution remains the source of truth for protected app routes

## Workspace Shell

- [x] `/$budId/new` and `/$budId/$threadId` render through the same shared workspace shell
- [x] Bud switching still updates the workspace correctly
- [x] thread switching still updates the workspace correctly
- [x] settings navigation from the Bud rail still works

## Models / Composer

- [x] model lists load correctly
- [x] alias filtering/default-model selection still works
- [x] composer submit behavior remains correct in both new-thread and existing-thread views

## Transcript / Agent Stream

- [x] optimistic user messages reconcile correctly with canonical persisted rows
- [x] draft assistant rows reconcile correctly with canonical persisted rows
- [x] pending tool rows reconcile correctly with canonical persisted rows
- [x] older-message pagination preserves the visible scroll anchor correctly
- [x] agent SSE reconnect/resume still works
- [x] explicit agent resync still refreshes and reattaches correctly
- [x] thread title updates still patch the Bud-level thread list correctly

## Terminal Runtime

- [x] terminal session creation still works on thread entry
- [x] terminal history replay still works
- [x] browser keyboard input still translates correctly
- [x] paste handling still translates correctly
- [x] terminal resize still syncs correctly
- [x] terminal reconnect behavior still works after transient disconnects
- [x] Bud offline/online transitions still recover correctly
- [x] thread switching does not leave the old thread terminal state stuck onscreen

## UI / UX

- [x] system theme mode responds to OS theme changes while the app is open
- [x] thread deletion failures are visible to the user
- [x] session close failures are visible to the user
- [x] placeholder controls that remain for future feature PRs are explicitly documented as intentional deferrals and not treated as refactor regressions

## Performance / Rendering

- [x] tool payload rendering still works after any lazy-loading changes
- [x] markdown/code block rendering still works after any lazy-loading changes
- [x] the timeline remains responsive on longer transcripts

## Documentation / Specs

- [x] `web/web.spec.md` describes the new layout accurately
- [x] `web/src/src.spec.md` describes the new layout accurately
- [x] affected route/lib/component/context specs are updated
- [x] any new extracted source folders include folder-level spec files
