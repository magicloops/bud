# Fix Web View Plan Spec

## Purpose

This folder contains the implementation plan for fixing web-view regressions
found after the staged `*.bud.show` rollout:

- switching between Terminal and Web remounts the iframe with a consumed
  one-time viewer grant, producing `invalid_viewer_grant`
- the Web view host/port/path controls can show stale local form state rather
  than the selected proxied site's target
- after a Bud reconnect, the terminal can recover while the Web view remains
  stuck behind a stale offline proxy transport snapshot
- the action form for choosing/opening local sites should be hidden by default
  and available from a top-header settings button

The plan keeps this as a web-client lifecycle, state-synchronization, and
recovery-refresh/UI-density fix. It does not change the proxy service,
viewer-grant semantics, Cloudflare routing, or daemon proxy protocol.

## Files

- `implementation-spec.md`: Overall approach, constraints, affected surfaces,
  acceptance criteria, and validation plan.
- `phase-1-preserve-web-view-iframe-lifecycle.md`: Keep the Web view iframe
  mounted across Terminal/Web tab switches and hide it when inactive.
- `phase-2-active-site-form-state.md`: Synchronize the Web view form controls
  with the active proxied site and prevent stale port display.
- `phase-3-reconnect-transport-refresh.md`: Refresh Web view proxy transport
  state on explicit reload and guarded Bud reconnect recovery.
- `phase-4-collapsible-web-view-controls.md`: Hide the Web view Site/Host/Port/
  Path/Name/Open controls by default behind a top-header settings button.

## Dependencies

- [../../debug/web-proxy-tab-switch-invalid-viewer-grant.md](../../debug/web-proxy-tab-switch-invalid-viewer-grant.md)
  - investigation note for the tab-switch grant replay and stale port state.
- [../../debug/web-proxy-reconnect-stale-offline-transport.md](../../debug/web-proxy-reconnect-stale-offline-transport.md)
  - investigation note for stale offline Web view transport after Bud reconnect.
- [../web-proxy/web-proxy.spec.md](../web-proxy/web-proxy.spec.md) - existing
  web-proxy product and implementation plan.
- [../../web/web.spec.md](../../web/web.spec.md) - web app package spec.
- [../../web/src/components/workbench/workbench.spec.md](../../web/src/components/workbench/workbench.spec.md)
  - workbench component ownership.
- [../../web/src/features/threads/threads.spec.md](../../web/src/features/threads/threads.spec.md)
  - thread feature hooks and state ownership.
- [../../web/src/routes/$budId/budId.spec.md](../../web/src/routes/$budId/budId.spec.md)
  - thread route and workbench composition.

## Primary Areas Expected To Change

- `web/src/components/workbench/thread-terminal-pane.tsx`: preserve the Web view
  subtree and toggle visibility rather than rendering it conditionally.
- `web/src/components/workbench/web-view-pane.tsx`: derive editable controls
  from the selected active site, avoid stale port display, and collapse the
  action controls behind a settings toggle.
- `web/src/routes/$budId/$threadId.tsx`: only if the pane composition needs a
  small prop adjustment for hidden-but-mounted behavior or a guarded reconnect
  refresh trigger.
- `web/src/features/threads/use-web-view.ts`: refresh active Web view transport
  state before explicit reload grants and keep tab switching free of service
  calls.

## Fixed Direction

- Keep the iframe mounted across Terminal/Web tab switches.
- Do not mint a new viewer grant on ordinary tab activation.
- Keep explicit Reload/Open actions as the paths that mint fresh viewer grants.
- Do not store or remount the iframe with a previously consumed bootstrap URL
  as a way to handle tab switches.
- Sync the Web view form from `activeSite` when the active proxied site changes,
  while avoiding clobbering in-progress edits for the same active site.
- Treat explicit Web view reload as an authoritative site/transport refresh,
  not only a viewer-grant mint.
- Refresh stale unavailable Web view transport after Bud reconnect only when
  the pane has an active site and the previous transport snapshot was
  unavailable.
- Hide the Site/Host/Port/Path/Name/Open row by default and expose it through a
  top-header settings/tuning icon.
- Keep the implementation web-only unless validation finds a separate mobile
  restore issue.

## Open Decision Gates

- Whether a later hardening pass should add a clean `view_url` iframe
  state-machine after bootstrap completion. This is useful, but not needed for
  the first robust fix if the iframe stays mounted.
- Whether the Web view controls should eventually split into explicit "Active
  site settings" and "Open another local app" surfaces. The first fix should
  keep the current UI shape and remove stale values.
- Whether standalone-open controls should be disabled when the embedded pane's
  current transport snapshot is unavailable. That is a follow-up UX decision,
  separate from stale transport recovery.
- Whether the controls-expanded state should persist per thread or user. Phase 4
  keeps it local and collapsed by default.
