# Validation Checklist: Web Architecture Refactor

## Auth / Session Shell

- [ ] anonymous access to `/` redirects correctly to `/login`
- [ ] authenticated access to `/`, `/$budId`, and `/settings` works without duplicate redirect loops
- [ ] root current-user resolution remains the source of truth for protected app routes

## Workspace Shell

- [ ] `/$budId/new` and `/$budId/$threadId` render through the same shared workspace shell
- [ ] Bud switching still updates the workspace correctly
- [ ] thread switching still updates the workspace correctly
- [ ] settings navigation from the Bud rail still works

## Models / Composer

- [ ] model lists load correctly
- [ ] alias filtering/default-model selection still works
- [ ] composer submit behavior remains correct in both new-thread and existing-thread views

## Transcript / Agent Stream

- [ ] optimistic user messages reconcile correctly with canonical persisted rows
- [ ] draft assistant rows reconcile correctly with canonical persisted rows
- [ ] pending tool rows reconcile correctly with canonical persisted rows
- [ ] older-message pagination preserves the visible scroll anchor correctly
- [ ] agent SSE reconnect/resume still works
- [ ] explicit agent resync still refreshes and reattaches correctly
- [ ] thread title updates still patch the Bud-level thread list correctly

## Terminal Runtime

- [ ] terminal session creation still works on thread entry
- [ ] terminal history replay still works
- [ ] browser keyboard input still translates correctly
- [ ] paste handling still translates correctly
- [ ] terminal resize still syncs correctly
- [ ] terminal reconnect behavior still works after transient disconnects
- [ ] Bud offline/online transitions still recover correctly
- [ ] thread switching does not leave the old thread terminal state stuck onscreen

## UI / UX

- [ ] system theme mode responds to OS theme changes while the app is open
- [ ] thread deletion failures are visible to the user
- [ ] session close failures are visible to the user
- [ ] placeholder controls that are not backed by real functionality are hidden or explicitly gated

## Performance / Rendering

- [ ] tool payload rendering still works after any lazy-loading changes
- [ ] markdown/code block rendering still works after any lazy-loading changes
- [ ] the timeline remains responsive on longer transcripts

## Documentation / Specs

- [ ] `web/web.spec.md` describes the new layout accurately
- [ ] `web/src/src.spec.md` describes the new layout accurately
- [ ] affected route/lib/component/context specs are updated
- [ ] any new extracted source folders include folder-level spec files
