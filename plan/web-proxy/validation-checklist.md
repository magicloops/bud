# Web Proxy Validation Checklist

## Ownership And Authorization

- [ ] Owner can create a proxied site for their Bud.
- [ ] Owner can list only their Bud's proxied sites.
- [x] Signed-in non-owner gets `404` for another user's proxied site.
- [x] Unauthenticated API caller gets `401`.
- [ ] Thread attach derives Bud from authorized thread.
- [ ] Thread cannot attach another user's proxied site.
- [x] Gateway resolves endpoint host to site before auth.
- [x] Gateway validates viewer cookie before daemon stream allocation.
- [x] Disabled and expired sites reject API attach and gateway traffic.

## Target Safety

- [x] `127.0.0.1` target is accepted.
- [x] `::1` target is accepted.
- [x] Exact `localhost` target is accepted.
- [x] `localhost` resolves only to loopback addresses on daemon.
- [x] LAN addresses are rejected.
- [ ] Metadata service addresses are rejected.
- [x] Arbitrary hostnames are rejected.
- [ ] Unix sockets and file paths are rejected.
- [ ] Redirects cannot expand local target access beyond policy.

## Gateway Auth And Cookies

- [x] Viewer grant can be minted only by owner.
- [x] Viewer grant expires quickly.
- [x] Viewer grant is one-time use.
- [x] Bootstrap host must match endpoint host.
- [x] Viewer cookie max age is 7 days.
- [x] Viewer cookie refresh/update window is roughly 1 day.
- [x] Viewer cookie is host-only for the endpoint host.
- [x] Viewer cookie is `HttpOnly`.
- [x] Viewer cookie is `Secure` in production.
- [x] Viewer cookie supports iframe access in Chrome where possible.
- [ ] Iframe fallback to top-level opening works when cookie access is blocked.
- [x] Local app cannot overwrite reserved gateway cookie names.
- [x] `bud.dev` cookies are never forwarded upstream.

## Diagnostics And Capability Surfacing

- [ ] Current proxy reset logs include canonical error code, stream id, site id,
  Bud id, transport kind, and request path.
- [ ] Daemon reset logs include inbound error code and stream id.
- [ ] Proxy logs omit grants, cookies, request bodies, and response bodies.
- [x] API/tool/UI state can report WebSocket/HMR unsupported or unavailable.
- [ ] API/tool/UI state can report local WebSocket connect failure.
- [ ] API/tool/UI state can report WebSocket connection limit failures.
- [ ] API/tool/UI state can report transport loss after a proxied site is open.
- [x] Gateway auth failures, disabled sites, and expired sites are rejected before
  daemon stream allocation.

## HTTP Proxy Fidelity

- [x] Root HTML loads.
- [x] Small first-load HTTP responses do not reset with
  `FINAL_OFFSET_MISMATCH` when `stream_data` and `stream_close` arrive
  back-to-back.
- [x] Root-absolute assets load, for example `/src/main.tsx`.
- [ ] Query strings are preserved.
- [x] `GET` works.
- [ ] `HEAD` works.
- [ ] `POST` JSON works.
- [ ] Form submissions work.
- [ ] Multipart body under the cap works.
- [ ] Oversized request body returns `413`.
- [ ] `PUT`, `PATCH`, `DELETE`, and `OPTIONS` work.
- [ ] `CONNECT` and `TRACE` are rejected.
- [ ] Browser disconnect cancels daemon/local request.
- [x] Active HTTP proxy streams clean up on daemon disconnect.
- [x] Local app endpoint-host cookies round-trip.
- [ ] Redirects from local target URLs rewrite to endpoint host.
- [ ] Hop-by-hop headers are stripped.

## WebSocket And HMR

- [x] Unauthorized upgrade does not allocate daemon state.
- [x] Authorized endpoint-host upgrade dispatches daemon WebSocket open after
  viewer-cookie auth.
- [ ] Authorized WebSocket connects to local echo server.
- [x] Text frames round-trip through the service runtime.
- [x] Binary frames round-trip through the service runtime.
- [x] Close code/reason propagate through the service runtime.
- [x] Gateway oversized-message failure closes with typed service behavior.
- [x] Gateway open-timeout failure closes with typed service behavior.
- [x] Active sockets close on site disable.
- [x] Active sockets close on site expiry.
- [x] Active sockets close through Bud-level runtime cleanup helper.
- [x] Active sockets close on daemon disconnect.
- [x] Per-site connection limit is enforced.
- [x] Per-Bud connection limit is enforced.
- [x] Vite HMR connects through endpoint host.
- [x] Vite component edit updates without manual reload.
- [ ] Stable idle Vite HMR does not produce a request/reset storm.

## Web Client

- [ ] Web view tab can create/reuse a site by port/path.
- [ ] Web view tab can attach an existing site.
- [ ] Web view tab can detach without disabling.
- [ ] Web view tab can disable a site with explicit action.
- [ ] Web view tab can reload iframe.
- [ ] Web view tab can open standalone.
- [ ] Web view tab can copy stable endpoint URL.
- [ ] Site picker updates from SSE.
- [ ] Active pane updates when site is disabled/expired/offline.
- [ ] Auth-blocked iframe shows standalone fallback.
- [x] Web view shows specific Bud offline state.
- [x] Web view shows specific WebSocket unsupported/unavailable state.
- [ ] Web view shows specific local connect failure state.
- [ ] Web view shows specific connection limit exceeded state.

## iOS Client

- [x] iOS can request a viewer grant through authenticated API.
- [x] iOS can open bootstrap URL in hosted web view.
- [x] iOS does not need custom subresource auth headers.
- [ ] iOS handles offline/disabled/expired product pages.
- [ ] iOS can open the same proxied site across app launches while cookie is
  valid.

## Agent Tools

- [ ] `web_view.open` creates/reuses a private owner site.
- [ ] `web_view.open` attaches current thread.
- [ ] `web_view.open` rejects invalid ports/paths.
- [ ] `web_view.open` rejects unsupported or offline Buds with structured
  output.
- [ ] `web_view.close` detaches by default.
- [ ] `web_view.close` disables only with explicit flag.
- [ ] `web_view.list` filters by current Bud/owner.
- [ ] Tool results do not expose grants, cookies, or daemon stream IDs.

## Local Development

- [x] New developer can run web, service, and daemon locally without a separate
  tunnel dependency.
- [x] New developer can run the default local stack without installing Caddy or
  mkcert.
- [ ] `proxy.localhost` route works where supported.
- [ ] `nip.io` fallback route works where supported.
- [x] HTTP-only local development path is documented.
- [x] Optional mkcert+Caddy HTTPS recipe is documented.
- [x] Docs explain how to upgrade from HTTP local dev to HTTPS parity mode and
  how to switch back.
- [x] HTTPS local app route works at `https://localhost:3443`.
- [x] HTTPS local API/SSE route works at `https://localhost:3443`.
- [x] HTTPS local Bud WebSocket route works at `wss://localhost:3443/ws`.
- [x] HTTPS local proxy endpoint hosts work at
  `https://<slug>.bud-proxy.localhost:3443`.
- [x] HTTPS local proxy endpoint hosts work at
  `https://<slug>.bud-show.test:3443`.
- [x] Local DNS resolves `smoke.bud-show.test` to `127.0.0.1`.
- [x] Setup/check commands validate local `.test` DNS before treating the
  HTTPS profile as ready.
- [ ] iOS Simulator Safari resolves and loads the `.test` proxy endpoint host.
- [x] Bud iOS WKWebView resolves and loads the `.test` proxy endpoint host.
- [x] HTTPS local iframe bootstrap sends a `SameSite=None; Secure` viewer
  cookie on the redirected clean request.
- [x] Root README/getting-started docs explain when to use HTTP vs HTTPS local
  development.

## Production Deployment

- [ ] Wildcard DNS exists for `*.bud.show`.
- [ ] Wildcard TLS certificate automation exists.
- [ ] Load balancer routes `*.bud.show` to gateway handler.
- [ ] WebSocket upgrades are allowed through production edge.
- [ ] Gateway logs omit cookies, grants, request bodies, and WS payloads.
- [ ] Metrics track requests, bytes, latency, auth failures, daemon disconnects,
  and active WebSockets.
- [ ] Rate limits and quotas are configured before broad rollout.
