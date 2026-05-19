# Plan: Fix Web View Lifecycle, Form State, Reconnect Recovery, And Controls

## Context

After the `*.bud.show` staging rollout was validated, the web client showed
`{"error":"invalid_viewer_grant"}` when a user opened a proxied Web view,
switched to Terminal, then switched back to Web. The debug pass found that the
Web view iframe is unmounted on Terminal activation while `useWebView` keeps
the old one-time `bootstrap_url` in state. When the Web tab remounts, the new
iframe requests the same consumed bootstrap grant.

The same review found a smaller settings-header issue: the editable Port value
is local form state initialized to `5173`, not a value synchronized from the
selected active proxied site.

After the first two fixes were validated, a follow-up reconnect bug was found:
when a Bud comes back online, the Terminal view recovers, but the embedded Web
view can remain stuck behind the last offline proxy transport snapshot until
the whole web app page is refreshed.

Finally, the Web view action form is currently always visible. That makes local
site setup easy, but it spends vertical space and visual attention during the
common path where a user is only viewing an already attached page.

Related docs:

- [../../debug/web-proxy-tab-switch-invalid-viewer-grant.md](../../debug/web-proxy-tab-switch-invalid-viewer-grant.md)
- [../../debug/web-proxy-reconnect-stale-offline-transport.md](../../debug/web-proxy-reconnect-stale-offline-transport.md)
- [../web-proxy/phase-3-web-and-mobile-client-surfaces.md](../web-proxy/phase-3-web-and-mobile-client-surfaces.md)
- [fix-web-view.spec.md](fix-web-view.spec.md)

## Objective

Fix the web UX so:

- switching Terminal/Web does not reload or recreate the proxied app iframe
- normal tab switching never replays a consumed viewer-grant bootstrap URL
- local app state, HMR sockets, scroll position, and in-page navigation survive
  Terminal/Web tab switches
- the Web view Port control reflects the active site after selecting or opening
  a different proxied site
- Web view reload recovers from stale offline proxy transport after a Bud
  reconnect
- a Bud reconnect can refresh stale unavailable Web view transport without
  reloading healthy iframes repeatedly
- the Site/Host/Port/Path/Name/Open controls are hidden by default and opened
  from a top-header settings button

## Non-Goals

- No change to one-time viewer-grant semantics.
- No service, database, daemon, Cloudflare, or Render changes.
- No mobile client changes unless a separate mobile restore bug is confirmed.
- No broad Web view UI redesign.
- No requirement to always reload the iframe when returning to the Web tab.
- No service-side reconnect event or proxy transport contract change.
- No durable user preference for Web view controls-expanded state.

## Design / Approach

### Phase 1: Preserve The Iframe Lifecycle

`ThreadTerminalPane` already preserves the terminal DOM by hiding it when the
Web view is active. Apply the same model to the Web view overlay:

- render the `webViewPane` subtree whenever it exists, not only when
  `viewMode === "web"`
- use CSS visibility, opacity, z-index, and pointer-event classes to make the
  hidden Web pane inert while Terminal is active
- keep the iframe `key` and `src` stable during tab switches
- avoid calling `reloadWebView`, `refreshWebViews`, or viewer-grant creation on
  view-mode changes
- keep the existing explicit Reload/Open flows as the only user-facing refresh
  paths

This is the simplest robust fix because it removes the remount that triggers
grant replay and preserves the local app runtime exactly as users expect.

### Phase 2: Sync Active-Site Form State

`WebViewPane` should treat the selected proxied site as the source of truth when
the active site changes:

- initialize the host, port, and path fields from `activeSite` when a site is
  attached or selected
- reset any local "dirty" edit marker when the active proxied site id changes
- do not clobber in-progress edits for the same active site while the user is
  typing
- keep the current default of `localhost:5173/` only when there is no active
  site to derive from
- keep the Name field as an optional label override for the next Open action
  rather than treating it as an active-site edit field
- ensure the Open action submits the visible form values

This keeps the current UI shape while removing the misleading stale port value.

### Phase 3: Refresh Reconnect Transport State

`useWebView` stores a REST snapshot of proxy transport availability. When that
snapshot says the Bud is offline, `WebViewPane` hides the iframe locally before
navigation. After Bud reconnect, the terminal state can recover through
terminal SSE while the Web view still has the old unavailable transport object.

Make recovery explicit:

- change explicit Web view reload so it refreshes the active thread Web view,
  site list, and transport snapshot before applying a new iframe grant
- add a guarded route-level reconnect trigger that calls `refreshWebViews()`
  only after terminal recovery transitions to connected and the current Web view
  transport snapshot is unavailable
- avoid refreshing on normal Terminal/Web tab switches
- avoid refreshing healthy Web views on every terminal heartbeat/status update
- keep standalone open behavior unchanged for connected Buds

This preserves the iframe lifecycle behavior from Phase 1 while making Bud
offline recovery converge without a whole-page refresh.

### Phase 4: Collapse Web View Controls By Default

`WebViewPane` currently renders the Site/Host/Port/Path/Name/Open action row
unconditionally below the top header. Keep those controls, but hide them by
default behind a top-header settings/tuning icon.

The settings button should live beside Reload, Open standalone, and Detach. It
should toggle the action form without changing iframe `src`, iframe `key`, or
Web view hook state. Form state remains owned by `WebViewPane`, so values can
survive collapsing and expanding.

This is a presentation-only change:

- no service calls on settings toggle
- no viewer-grant mint on settings toggle
- no iframe remount on settings toggle
- no persistent preference in the first pass

## Spec Files To Update When Implementing

- [ ] `web/src/components/workbench/workbench.spec.md`
- [ ] `web/src/features/threads/threads.spec.md`
- [ ] `web/src/routes/$budId/budId.spec.md` if route composition changes
- [ ] `plan/fix-web-view/fix-web-view.spec.md` if scope or sequencing changes

## Impacted Contracts

- [ ] WSS protocol: no
- [ ] SSE events: no
- [ ] DB schema: no
- [ ] Agent tools: no
- [x] Web UI: yes
- [ ] Service proxy gateway: no
- [ ] Mobile client: no

## Test Plan

Automated checks, if supported by the current web test harness:

1. Render the thread pane with a Web view, switch to Terminal, then back to Web
   and assert the iframe element was not recreated.
2. Render `WebViewPane` with one active site, rerender with a different active
   site, and assert the Port input updates to the new site's port.
3. Assert user edits for the current active site are not overwritten by an
   unrelated rerender.

Manual validation:

1. Start the HTTPS local stack or use staging where `*.bud.show` is already
   validated.
2. Open a thread Web view for a proxied local app.
3. In browser network tooling, confirm the initial
   `/__bud/bootstrap?grant=...` request redirects successfully.
4. Switch Terminal -> Web several times.
5. Confirm no second request is made to the same bootstrap URL.
6. Confirm no `invalid_viewer_grant` response appears.
7. Confirm app state inside the iframe survives tab switching.
8. Click explicit Reload and confirm a fresh viewer grant is minted and works.
9. Select or open sites on different ports and confirm the Port input follows
   the active site's target.
10. Disconnect/reconnect the Bud and confirm the Web pane's stale offline
    transport state recovers after terminal reconnect or explicit Reload.
11. Confirm a healthy iframe is not reloaded by ordinary Terminal/Web tab
    switching after the reconnect fix.
12. Confirm the Web view action form is hidden by default and toggles from the
    top-header settings button without reloading the iframe.

Recommended package checks after implementation:

```bash
pnpm --dir /Users/adam/bud/web test
pnpm --dir /Users/adam/bud/web build
```

If either command is not available or fails for environment reasons, record the
exact output in the implementation handoff.

## Rollout

1. Implement Phase 1 and validate that iframe tab switching no longer triggers
   grant replay.
2. Implement Phase 2 and validate active-site form synchronization.
3. Implement Phase 3 and validate explicit reload plus Bud reconnect recovery.
4. Implement Phase 4 and validate the collapsed-controls UX.
5. Update the affected web specs.
6. Include the debug notes and this plan in the PR summary.

## Acceptance Criteria

- Switching Terminal/Web does not unmount the iframe.
- Switching Terminal/Web does not call viewer-grant creation.
- Switching Terminal/Web does not replay an old bootstrap URL.
- The proxied page remains interactive after returning to Web.
- The Port input matches the selected active site after site selection.
- Explicit Open/Reload behavior remains unchanged and still works.
- Explicit Reload refreshes stale Web view proxy transport state.
- Bud reconnect recovery clears a stale unavailable Web view transport snapshot
  without relying on a whole-page refresh.
- Web view action controls are hidden by default and can be toggled from the top
  header without reloading the iframe.
