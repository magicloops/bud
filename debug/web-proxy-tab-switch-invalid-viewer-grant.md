# Debug: Web Proxy Tab Switch Invalid Viewer Grant

## Environment

- Date: 2026-05-18
- Workspace: `/Users/adam/bud`
- Reported environment: deployed staging after `*.bud.show` validation
- Clients: web confirmed; mobile not yet confirmed
- Investigation method: static implementation review only; no code changes made

## Repro Steps

1. Open a thread in the web client.
2. Open a Web view for an attached proxied site.
3. Confirm the proxied page loads.
4. Switch from the Web view tab to the Terminal tab.
5. Switch back to the Web view tab.
6. Observe the iframe/body render `{"error":"invalid_viewer_grant"}`.
7. Recover by refreshing the app page or clicking the Web view `Open` button.

Related secondary issue:

1. Open or select one proxied site.
2. Open or select another proxied site.
3. Observe the settings header `Port` input showing a previous/default port
   rather than the active proxied site's port.

## Observed

- External opening still works.
- Refreshing the app page works.
- Clicking the Web view `Open` button works.
- The failure body is `invalid_viewer_grant`, not
  `proxy_viewer_unauthorized`.
- That points specifically at the bootstrap route consuming a bad, expired, or
  already-consumed one-time viewer grant.

## Expected

- Switching between Terminal and Web view should either preserve the already
  authenticated iframe or remount it at a non-consumable clean view URL.
- If the pane needs to re-bootstrap, it should mint a fresh viewer grant before
  iframe navigation.
- The manual host/port/path controls should reflect the active site or clearly
  remain an independent "new site" form.

## Reviewed Files

- `plan/web-proxy/web-proxy.spec.md`
- `plan/web-proxy/phase-2-proxy-domain-gateway-and-private-auth.md`
- `plan/web-proxy/phase-3-web-and-mobile-client-surfaces.md`
- `plan/web-proxy/mobile-handoff.md`
- `design/web-serving-preview-domain-architecture.md`
- `web/web.spec.md`
- `web/src/src.spec.md`
- `web/src/features/threads/threads.spec.md`
- `web/src/features/threads/use-web-view.ts`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/components/workbench/web-view-pane.tsx`
- `web/src/components/workbench/thread-terminal-pane.tsx`
- `web/src/components/workbench/workspace-shell.tsx`
- `web/src/components/workbench/workspace-top-bar.tsx`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/lib/api-types.ts`
- `web/src/lib/transport.ts`
- `service/src/routes/routes.spec.md`
- `service/src/routes/proxied-sites.ts`
- `service/src/proxy/proxy.spec.md`
- `service/src/proxy/proxied-site.ts`
- `service/src/proxy/proxy-edge.ts`
- `service/src/proxy/proxy-ws-edge.ts`
- `service/src/routes/proxied-sites.test.ts`
- `service/src/proxy/proxied-site.test.ts`
- `service/src/db/db.spec.md`
- Prior notes:
  - `debug/web-proxy-viewer-unauthorized.md`
  - `debug/web-proxy-web-view-request-loop.md`

## Current Flow

1. `useWebView.refreshWebViews()` loads owned sites and the current
   thread attachment, then calls `requestViewerGrant(...)` when a thread Web
   view exists.
2. `requestViewerGrant(...)` posts to
   `/api/proxied-sites/:proxied_site_id/viewer-grants`.
3. The service creates a short-lived grant and returns both:
   - `bootstrap_url`
   - `view_url`
4. The hook stores `grant.bootstrap_url` in `iframeSrc`.
5. `WebViewPane` renders an iframe with `src={iframeSrc}` and
   `key={iframeUrl}`.
6. The endpoint-host bootstrap route consumes the grant, sets the viewer
   cookie, and redirects to the clean proxied URL.
7. On the service, `consumeViewerGrant(...)` only accepts rows whose
   `consumedAt` is still null. Reusing the same bootstrap URL returns
   `invalid_viewer_grant`.

## Findings

### 1. The Web view iframe is unmounted when switching to Terminal

`ThreadTerminalPane` renders the Web view overlay only when
`viewMode === 'web'`. Switching to Terminal removes the overlay and the
`WebViewPane` subtree, including the iframe. The terminal DOM is preserved
underneath, but the Web view DOM is not.

Relevant code:

- `web/src/components/workbench/thread-terminal-pane.tsx:78`
- `web/src/routes/$budId/$threadId.tsx:486`
- `web/src/routes/$budId/$threadId.tsx:487`

### 2. The hook keeps the old bootstrap URL after the iframe is destroyed

`useWebView` stays mounted at the route level, so its state survives tab
switches. That includes `iframeSrc`, which is set to the one-time
`grant.bootstrap_url` and is not cleared or replaced when the Web tab is
hidden.

Relevant code:

- `web/src/features/threads/use-web-view.ts:59`
- `web/src/features/threads/use-web-view.ts:105`
- `web/src/features/threads/use-web-view.ts:175`

### 3. Remounting the Web view re-requests the same consumed bootstrap URL

When the user switches back to Web view, `WebViewPane` remounts and renders a
new iframe with the persisted `iframeSrc`. Because that URL is still the old
`/__bud/bootstrap?grant=...` URL, the browser makes a second bootstrap request
for the same one-time grant.

The service rejects that exact case as `invalid_viewer_grant`.

Relevant code:

- `web/src/components/workbench/web-view-pane.tsx:263`
- `web/src/components/workbench/web-view-pane.tsx:265`
- `web/src/components/workbench/web-view-pane.tsx:267`
- `service/src/routes/proxied-sites.ts:341`
- `service/src/routes/proxied-sites.ts:350`
- `service/src/proxy/proxied-site.ts:662`
- `service/src/proxy/proxied-site.ts:669`
- `service/src/proxy/proxied-site.ts:673`

### 4. The web client ignores `view_url` for embedded state

The viewer-grant API already returns a clean `view_url`, but `useWebView`
stores the bootstrap URL for both `iframeSrc` and `standaloneUrl`. After a
successful bootstrap, there is no parent-side transition from bootstrap URL to
clean URL.

Because the parent cannot read the cross-origin iframe's final URL, it never
learns that the iframe has reached `view_url`.

Relevant code:

- `service/src/routes/proxied-sites.ts:291`
- `service/src/routes/proxied-sites.ts:292`
- `service/src/routes/proxied-sites.ts:293`
- `web/src/features/threads/use-web-view.ts:105`
- `web/src/features/threads/use-web-view.ts:106`

### 5. The recovery paths all mint or force a fresh bootstrap

The reported recovery behavior matches the implementation:

- whole-page refresh remounts `useWebView`, and the mount effect calls
  `refreshWebViews()`, which mints a new grant
- clicking the Web view `Open` button calls `openLocalApp(...)`, which creates
  or reuses the site and then mints a new grant
- clicking reload calls `reloadWebView(...)`, which also mints a new grant
- external opening uses `openStandaloneWebView(...)`, which mints a fresh grant

Relevant code:

- `web/src/features/threads/use-web-view.ts:162`
- `web/src/features/threads/use-web-view.ts:255`
- `web/src/features/threads/use-web-view.ts:293`
- `web/src/features/threads/use-web-view.ts:315`

### 6. This is distinct from cookie or Cloudflare routing failures

`invalid_viewer_grant` is emitted by the bootstrap path before normal gateway
viewer-cookie authorization. Missing/blocked endpoint-host cookies would
produce `proxy_viewer_unauthorized` on the clean proxied path instead.

The fact that external open and refresh work also argues against `bud.show`
DNS, Worker, edge secret, or daemon proxy transport as the primary issue.

### 7. The Port input is local form state, not active-site state

`WebViewPane` initializes the form fields with local React state:

- `targetHost = 'localhost'`
- `targetPort = '5173'`
- `targetPath = '/'`
- `title = ''`

Those fields are not derived from `activeSite`, and there is no effect that
updates them when a site is selected or attached. The active title at the top
uses `activeSite.target_port`, while the editable `Port` input uses the stale
local `targetPort` state.

Relevant code:

- `web/src/components/workbench/web-view-pane.tsx:50`
- `web/src/components/workbench/web-view-pane.tsx:51`
- `web/src/components/workbench/web-view-pane.tsx:52`
- `web/src/components/workbench/web-view-pane.tsx:67`
- `web/src/components/workbench/web-view-pane.tsx:79`
- `web/src/components/workbench/web-view-pane.tsx:181`

## Hypotheses

### 1. Primary: tab switching remounts the iframe with a consumed bootstrap URL

Confidence: high.

Mechanism:

1. Web opens a proxied site and stores bootstrap URL A in `iframeSrc`.
2. Iframe loads bootstrap URL A.
3. Service consumes grant A, sets the viewer cookie, and redirects to `/`.
4. User switches to Terminal.
5. The iframe unmounts, but `useWebView.iframeSrc` remains bootstrap URL A.
6. User switches back to Web view.
7. A new iframe is created with bootstrap URL A.
8. Service sees grant A has already been consumed and returns
   `{"error":"invalid_viewer_grant"}`.

This exactly matches the symptom and the recovery paths.

### 2. Secondary: the embed source should probably become clean `view_url`

Confidence: high as a design contributor.

The parent has both `bootstrap_url` and `view_url`, but only persists the
consumable URL. A clean URL is safe to remount after the endpoint-host cookie
exists. Keeping bootstrap URL as long-lived pane state makes every iframe
remount capable of replaying a one-time grant.

The hard part is timing: setting the iframe to `view_url` too early can skip
bootstrap before the cookie is set. The implementation needs a deliberate
handoff strategy, not just a blind immediate replacement.

### 3. Secondary: Web tab activation should refresh auth if the iframe was not preserved

Confidence: medium-high.

Because `useWebView` does not know `viewMode`, switching back to Web view does
not mint a fresh grant. If the chosen UI model continues to unmount the iframe
while hidden, then Web-tab activation should probably call a refresh/reload
path or use a stored clean view URL after successful bootstrap.

### 4. Alternative: grant expires while hidden

Confidence: low for the reported repro, possible for long-hidden tabs.

Viewer grants are short-lived. If the iframe had never loaded the bootstrap URL
and the user left the tab hidden beyond the grant TTL, switching back could also
produce `invalid_viewer_grant`. The reported sequence loads the page first, so
already-consumed grant replay is more likely than expiry.

### 5. Mobile applicability depends on WebView reuse

Confidence: medium.

Mobile should not hit this if it opens a fresh bootstrap URL only once and then
keeps the same native web-view instance or later loads the clean endpoint URL
with the cookie jar intact. It can hit the same failure if the app stores and
reuses the original `bootstrap_url` when recreating a WKWebView or restoring a
view surface.

### 6. Port field bug is stale local form state

Confidence: high.

The form controls are independent from `activeSite`; selecting/attaching a site
does not update the form. The value can therefore reflect whichever default or
previous manual entry the component currently holds, rather than the selected
site.

## Proposed Fix Direction

No code changes were made in this pass. The implementation options to consider:

1. Preserve the Web view subtree while hidden.
   - Render `WebViewPane` continuously and hide it with CSS, similar to how the
     terminal is preserved.
   - This avoids iframe remount and avoids replaying bootstrap URLs.
   - Tradeoff: hidden iframes, HMR sockets, timers, and page activity keep
     running while the user is on Terminal.

2. Keep remounting, but never remount with a consumed bootstrap URL.
   - Track both `bootstrapUrl` and `viewUrl`.
   - Use bootstrap only for initial auth/reload.
   - After bootstrap has had a chance to complete, keep iframe state on the
     clean `viewUrl`.
   - This likely needs either an explicit gateway bootstrap landing page signal
     or a careful delayed/state-machine approach.

3. Treat Web-tab activation as an auth refresh point.
   - Pass `viewMode` or an `isVisible` flag into `useWebView`.
   - When becoming visible and the current iframe source is a bootstrap URL,
     mint a fresh grant before rendering the iframe.
   - This is simple but may reload the local app on every tab switch unless
     guarded carefully.

4. Add a small iframe lifecycle state machine.
   - States could distinguish `needs_bootstrap`, `bootstrapping`, and
     `viewing`.
   - Store the durable clean URL separately from the one-time bootstrap URL.
   - Avoid exposing raw grant URLs in copy/open UI.

5. For mobile, document that clients should not persist or restore
   `bootstrap_url`.
   - Persist/use `view_url` only after bootstrap succeeds, or request a fresh
     viewer grant whenever constructing a new hosted web-view navigation.

6. For the port bug, decide the intended UX:
   - If the form is "open a new local app", visually separate it from active
     site settings and do not imply it reflects active state.
   - If it is active-site settings, sync host/port/path/title from `activeSite`
     when the active site changes.
   - A conservative product fix is to initialize/sync the form from
     `activeSite` on active-site changes, while avoiding clobbering in-progress
     edits during an explicit manual edit.

## Validation Plan

For the `invalid_viewer_grant` issue:

1. Open browser DevTools Network and filter by the generated `*.bud.show` host.
2. Open a Web view and confirm:
   - `GET /__bud/bootstrap?grant=A...` returns `302`
   - the redirected clean URL returns the proxied page
3. Switch to Terminal.
4. Switch back to Web view.
5. Check whether the browser requests the same
   `/__bud/bootstrap?grant=A...` URL again.
6. If yes, this confirms the primary hypothesis.
7. Confirm no new `POST /api/proxied-sites/:id/viewer-grants` occurs on tab
   reactivation.
8. Click Reload/Open and confirm a new `grant=B` is minted and works.

For mobile:

1. Log whether the native client stores/restores `bootstrap_url` or only uses it
   immediately.
2. Destroy/recreate the web-view surface after a successful load.
3. If recreating with the old bootstrap URL fails, request a fresh grant or
   restore to clean `view_url` with the existing cookie jar.

For the port field:

1. Open or select a site for port `5173`.
2. Open or select a site for a different port.
3. Compare the header title's active target with the editable `Port` input.
4. Confirm whether the form stayed on old local state rather than active-site
   state.

## Files Likely Affected If Fixed

- `web/src/features/threads/use-web-view.ts`
- `web/src/components/workbench/web-view-pane.tsx`
- `web/src/components/workbench/thread-terminal-pane.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- Potential service-side support if adding an explicit bootstrap completion or
  auth-blocked postMessage page:
  - `service/src/routes/proxied-sites.ts`
  - `service/src/routes/proxied-sites.test.ts`
- Specs likely needing updates:
  - `web/src/features/threads/threads.spec.md`
  - `web/src/components/workbench/workbench.spec.md`
  - `web/src/routes/$budId/budId.spec.md`
  - `service/src/routes/routes.spec.md` if gateway behavior changes
