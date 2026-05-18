# Debug: web-proxy-viewer-unauthorized

## Environment
- Date: 2026-05-13
- Workspace: `/Users/adam/bud`
- Scenario: the agent opened a web view for `localhost:5173`; the Web view tab switched correctly, but the iframe rendered `{"error":"proxy_viewer_unauthorized"}`
- Local service config reviewed:
  - service port: `3000`
  - app/auth origin: `http://localhost:5173`
  - local proxy defaults: `http://<slug>.proxy.localhost:3000`
  - no `PROXY_*` overrides were found in the reviewed local env files
- Investigation method: static code review and local env review only; no code changes in this pass

## Repro Steps
1. Start the local Bud service, web dev server, daemon, and a local app on port `5173`.
2. Ask the agent to open a web view for `localhost:5173`.
3. Observe that the right pane switches to Web view.
4. Observe the iframe body render `{"error":"proxy_viewer_unauthorized"}`.

## Observed
- The thread/web UI mutation succeeded: the agent-created `web_view.open` result caused the route to switch to Web view and refresh the active attachment.
- The proxied endpoint host route is being reached. The error string comes from the proxy gateway, not from the web app route and not from the daemon.
- `proxy_viewer_unauthorized` is returned before transport readiness is checked and before a daemon proxy stream is allocated.
- Browser network evidence from the failing run:
  - the iframe bootstrap request to `/__bud/bootstrap?grant=...&to=%2F` returned `302`
  - the bootstrap response included `Set-Cookie: bud_proxy_viewer=...; Path=/; HttpOnly; Max-Age=604800; SameSite=Lax`
  - the redirected iframe request to `/` returned `401`
  - the redirected request did not include a `Cookie: bud_proxy_viewer=...` header
  - both iframe requests had `Sec-Fetch-Site: cross-site` and `Sec-Fetch-Dest: iframe`
- Follow-up standalone test:
  - opening a fresh bootstrap link in a new tab redirected to `http://localhost-5173-3k42y0.proxy.localhost:3000/`
  - the clean proxied URL now returns `502`
  - this is a different failure stage from the iframe `401`; detailed 502 analysis is tracked separately in `debug/web-proxy-standalone-502.md`

## Expected
- The web client should mint a one-time viewer grant from the authenticated Bud API.
- The iframe should first load the endpoint-host bootstrap URL.
- The bootstrap route should consume the grant, create a viewer session row, set the endpoint-host viewer cookie, and redirect to the clean proxied path.
- The clean proxied request should include the viewer cookie, pass gateway auth, and then open the daemon proxy stream.
- If embedded auth is blocked, the Web view pane should show an actionable fallback instead of exposing raw gateway JSON inside the iframe.

## Reviewed Files
- `service/src/proxy/proxy.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/auth/auth.spec.md`
- `web/src/features/threads/threads.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `service/src/config.ts`
- `service/src/server.ts`
- `service/src/proxy/proxied-site.ts`
- `service/src/routes/proxied-sites.ts`
- `service/src/proxy/proxy-edge.ts`
- `service/src/auth/session.ts`
- `service/src/agent/web-view-tool-executor.ts`
- `web/src/features/threads/use-web-view.ts`
- `web/src/components/workbench/web-view-pane.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- `plan/web-proxy/progress-checklist.md`
- `plan/web-proxy/validation-checklist.md`
- `plan/web-proxy/phase-2-proxy-domain-gateway-and-private-auth.md`
- `plan/web-proxy/phase-3-web-and-mobile-client-surfaces.md`
- `design/web-serving-preview-domain-architecture.md`

## Current Flow
1. `web_view.open` in `service/src/agent/web-view-tool-executor.ts` creates or reuses an owned `proxied_site` and attaches it to the current thread. It intentionally does not mint viewer grants or expose grant/cookie data to the model.
2. The web route sees the `web_view.*` tool result, switches `viewMode` to `web`, and calls `useWebView.refreshWebViews()`.
3. `useWebView.refreshWebViews()` loads:
   - `GET /api/buds/:budId/proxied-sites`
   - `GET /api/threads/:threadId/web-view`
4. When a thread attachment exists, `useWebView.requestViewerGrant()` calls `POST /api/proxied-sites/:proxiedSiteId/viewer-grants`.
5. The hook sets the iframe `src` to `grant.bootstrap_url`.
6. `GET /__bud/bootstrap?grant=...` on the endpoint host consumes the grant, inserts a viewer session, sets `Set-Cookie`, and redirects to the clean proxied URL.
7. All non-bootstrap gateway requests call `resolveViewerSession(...)` with `readCookie(request.headers.cookie, config.proxyViewerCookieName)`.
8. If that cookie is missing or invalid, the gateway returns `401 { "error": "proxy_viewer_unauthorized" }`.

## Findings

### 1. The failing response is specifically the endpoint-host viewer-cookie check

`service/src/routes/proxied-sites.ts` returns `proxy_viewer_unauthorized` only after:

- resolving the endpoint host to a `proxied_site`
- verifying the site is ready/openable
- trying to resolve the endpoint-host viewer session cookie

It returns before:

- checking proxy transport availability
- creating `bud_operation` / `bud_stream` rows
- sending `proxy_open` to the daemon
- connecting to `localhost:5173`

So this symptom is not primarily a Vite server issue, daemon connectivity issue, or proxy stream issue.

### 2. Local embedded auth is blocked by the current cookie attributes

In local HTTP mode, `buildViewerCookie(...)` emits:

```text
bud_proxy_viewer=<token>; Path=/; HttpOnly; Max-Age=604800; SameSite=Lax
```

The production HTTPS path emits `SameSite=None; Secure`, but local HTTP cannot set a valid `SameSite=None` cookie because browsers require `Secure`.

If Chrome treats the Web view iframe navigation from `http://localhost:5173` to `http://<slug>.proxy.localhost:3000` as a cross-site embedded context, the bootstrap redirect can create a viewer session row but the follow-up iframe request may not send the `SameSite=Lax` cookie. That lands exactly on `proxy_viewer_unauthorized`.

The captured request confirms this exact sequence: the `302` response sets the
cookie, but the next iframe navigation does not send it.

### 3. The current UI has a standalone fallback button, but no blocked-iframe state

`WebViewPane` renders the iframe whenever `iframeSrc` is present. It does not detect that the iframe loaded a gateway auth failure, and because the iframe is cross-origin, the parent cannot safely inspect its document body.

The design and phase plan call for an "Open in new tab" fallback when iframe private auth is blocked. The current UI exposes a standalone-open button, but it does not automatically replace the failed iframe with a clear fallback state.

### 4. The gateway currently returns raw JSON for missing viewer auth

For normal gateway navigation, `proxy_viewer_unauthorized` is returned as JSON. That is useful for API-like diagnostics, but a browser iframe displays it as the page body. We do not yet serve a product-safe private-access page that can tell the parent frame authentication failed or offer a top-level-open path.

### 5. Gateway auth and cookie coverage is still an explicit test gap

The progress and validation checklists still have unchecked items for gateway auth/security tests and iframe fallback behavior.

Existing route tests cover route registration and owner/non-owner API behavior. `proxied-site.test.ts` covers cookie string parsing. They do not yet cover the full bootstrap round trip:

- owner mints a grant
- endpoint host consumes it
- gateway sets the cookie
- clean endpoint request sends the cookie
- missing/invalid cookie fails before daemon allocation

### 6. Top-level standalone open should be the quickest discriminator

`useWebView.openStandaloneWebView()` mints a fresh grant and opens it in a new top-level window. In local HTTP mode, a `SameSite=Lax` cookie is much more likely to work in a top-level navigation than inside a cross-site iframe.

If standalone works but embedded iframe fails, the likely cause is embedded cookie policy. If standalone also fails, investigate host/cookie mismatch, grant consumption, session insertion, or gateway route configuration.

### 7. The current local HTTP setup cannot prove the production iframe path

The intended production private-iframe cookie is `SameSite=None; Secure`, which
requires HTTPS. The current local route is intentionally HTTP-only for
developer simplicity, so it can prove endpoint-host routing and standalone
bootstrap behavior, but it cannot faithfully prove the embedded production
cookie path.

## Hypotheses

### 1. Confirmed: the bootstrap succeeds, but the iframe follow-up request does not send the viewer cookie

Confidence: confirmed by browser network trace.

Mechanism:
1. Web asks the API for a viewer grant.
2. Iframe loads `http://<slug>.proxy.localhost:3000/__bud/bootstrap?...`.
3. Service consumes the grant and sets `bud_proxy_viewer` with `SameSite=Lax`.
4. Browser follows the redirect inside the iframe to `/`.
5. Because this is an embedded cross-site context, the browser does not send the Lax cookie.
6. Gateway returns `proxy_viewer_unauthorized`.

### 2. Possible: the iframe is loading the clean view URL directly instead of the bootstrap URL

Confidence: ruled out for the captured request.

The current hook sets `iframeSrc` to `grant.bootstrap_url`, so the implementation is intended to bootstrap first. This should still be verified in DevTools. If there is no `GET /__bud/bootstrap` request before the `proxy_viewer_unauthorized` page, the issue is in the frontend flow or stale iframe state.

The provided trace shows the iframe did load `/__bud/bootstrap` first.

### 3. Possible: the grant is consumed once, then a later iframe reload reuses the same bootstrap URL

Confidence: medium.

Viewer grants are one-time. A second request to the same bootstrap URL should return `invalid_viewer_grant`, not `proxy_viewer_unauthorized`. But a first successful bootstrap followed by a blocked/missing cookie would make subsequent clean-path requests unauthorized. DevTools and the `proxied_site_viewer_grant.consumed_at` / `proxied_site_viewer_session` rows can distinguish these.

### 4. Possible: endpoint-host cookie scope or proxy-domain config mismatch

Confidence: low.

The default local config stores endpoint hosts as `<slug>.proxy.localhost` and builds URLs with port `3000`, which should align with the gateway host normalization. This becomes more suspicious if `PROXY_BASE_DOMAIN` is set to include a port, because the code treats port separately through `PROXY_PUBLIC_PORT`.

### 5. Less likely: daemon/local target failure

Confidence: low.

The gateway returns this error before any daemon proxy stream work. Daemon failures should produce transport, timeout, local-connect, or proxy-open errors, not `proxy_viewer_unauthorized`.

## Proposed Fix Direction
- Add a local/browser validation pass before changing behavior:
  - confirm whether `GET /__bud/bootstrap?...` occurs
  - confirm whether the bootstrap response is `302` and includes `Set-Cookie`
  - confirm whether the redirected clean request includes `Cookie: bud_proxy_viewer=...`
  - confirm whether a `proxied_site_viewer_session` row is inserted
  - test the standalone-open button with a fresh grant
- Improve the gateway unauthenticated navigation response:
  - return a small HTML private-access page for document navigations instead of raw JSON
  - have that page `postMessage` an auth-blocked event to the parent when embedded
  - keep JSON for fetch-like or non-document requests
- Improve `WebViewPane` state:
  - listen for the gateway auth-blocked `postMessage`
  - replace the iframe with a concise "Open in new tab" fallback
  - expose reload/open-standalone without showing raw gateway JSON
- Decide local-dev policy:
  - either accept that HTTP iframe auth may fail locally and make standalone the supported local fallback
  - or add a first-class HTTPS local profile so we can use `SameSite=None; Secure` and test production-like iframe behavior
- Short-term implementation recommendation:
  - treat missing endpoint-host viewer cookies on document iframe requests as an auth-blocked iframe condition
  - return a small HTML page instead of JSON for document navigations
  - have that page notify the parent via `postMessage`
  - keep using the standalone top-level grant flow as the local HTTP fallback
- Production/parity recommendation:
  - keep `SameSite=None; Secure` for production `bud.show`
  - add an optional HTTPS local profile when we want embedded local parity
  - evaluate a `Partitioned` cookie variant for Chrome iframe resilience, but do not make it the only fallback
- Add gateway auth tests:
  - successful grant consumption and cookie authorization
  - missing cookie returns unauthorized before daemon allocation
  - consumed/expired grants fail
  - endpoint host must match the grant's site
  - local/prod cookie attributes match the intended policy
- Consider a production resilience pass:
  - evaluate adding a `Partitioned` viewer cookie for Chrome CHIPS-compatible iframe access
  - keep top-level standalone as the guaranteed path for browsers that block third-party cookies

## Validation Plan
- In DevTools Network, filter by the generated endpoint host.
- Check for this sequence:
  1. `GET /__bud/bootstrap?grant=...&to=/`
  2. response `302`
  3. response header includes `Set-Cookie: bud_proxy_viewer=...`
  4. redirected `GET /`
  5. request header includes `Cookie: bud_proxy_viewer=...`
- If step 5 is missing, classify as browser cookie policy / local HTTP SameSite behavior. This is the current confirmed failure.
- If step 1 is missing, inspect frontend iframe source and grant state.
- If step 2 is not `302`, inspect grant expiry, host matching, and one-time consumption.
- If step 5 exists but auth still fails, inspect token hashing/session DB rows and cookie name config.
- Click standalone open. If it works, prioritize iframe blocked-state UX and local HTTPS/CHIPS follow-up. If it fails, prioritize gateway/session persistence debugging.
- Standalone/new-tab `502` debugging is tracked in `debug/web-proxy-standalone-502.md`.

## Files Likely Affected If Fixed
- `service/src/routes/proxied-sites.ts`
- `service/src/proxy/proxied-site.ts`
- `service/src/routes/proxied-sites.test.ts`
- `service/src/proxy/proxied-site.test.ts`
- `web/src/features/threads/use-web-view.ts`
- `web/src/components/workbench/web-view-pane.tsx`
- Specs likely needing updates:
  - `service/src/routes/routes.spec.md`
  - `service/src/proxy/proxy.spec.md`
  - `web/src/features/threads/threads.spec.md`
  - `web/src/components/workbench/workbench.spec.md`
