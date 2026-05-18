# Phase 2: Proxy Domain Gateway And Private Auth

## Objective

Make private owner-only `bud.show` endpoint hosts load simple local web pages
through the active daemon. This phase proves the cross-origin product model,
auth bootstrap, cookie-backed access, and gateway-to-daemon HTTP proxy path for
`GET` and `HEAD` requests.

## Scope

- Add host-routed proxy gateway handling for configured proxy domains.
- Add viewer grant and viewer session persistence.
- Add `bud.dev` authenticated route to mint a short-lived viewer grant.
- Add `bud.show` bootstrap route to consume the grant and set viewer cookies.
- Proxy authorized `GET`/`HEAD` requests through the active daemon to loopback
  targets.
- Add local development routing for wildcard proxy hosts.
- Add auth, cookie, and disabled-site security tests.

## Non-Goals

- No request bodies yet.
- No WebSocket upgrades yet.
- No public/password sharing.
- No arbitrary target hosts.
- No full local HTTPS requirement.
- No separate proxy service.

## Gateway Host Routing

Production:

- `bud.dev`: web app, API, Better Auth.
- `*.bud.show`: proxy endpoint hosts and bootstrap responses.

Local development:

- Service/API: `http://localhost:3000`.
- Web: `http://localhost:5173`.
- Proxy gateway: `http://<endpoint_id>.proxy.localhost:3000`.
- Fallback gateway: `http://<endpoint_id>.127.0.0.1.nip.io:3000`.

Add configuration:

- `PROXY_BASE_DOMAIN`, default `bud.show` in production.
- `PROXY_LOCAL_BASE_DOMAIN`, default `proxy.localhost`.
- `PROXY_PUBLIC_SCHEME`, default `https` in production and `http` locally.
- `PROXY_VIEWER_COOKIE_NAME`, with a production reserved prefix such as
  `__Host-bud_proxy_viewer`. Local HTTP development may need an unprefixed
  dev-only name because `__Host-` cookies require `Secure`.
- `PROXY_VIEWER_COOKIE_MAX_AGE_SECONDS`, default `604800`.
- `PROXY_VIEWER_COOKIE_REFRESH_SECONDS`, default `86400`.
- `PROXY_BOOTSTRAP_GRANT_TTL_SECONDS`, default 300.
- `PROXY_GATEWAY_ENABLED`, default false until rollout.

## Viewer Grant Flow

Add route:

```http
POST /api/proxied-sites/:proxied_site_id/viewer-grants
```

Behavior:

1. Authorize the current `bud.dev` session.
2. Resolve `proxied_site` through owner-aware helper.
3. Reject disabled or expired sites.
4. Create a one-time `proxied_site_viewer_grant` with short expiry.
5. Return a `bootstrap_url` on the endpoint host.

Representative response:

```json
{
  "bootstrap_url": "https://vite-dev-a8f2.bud.show/__bud/bootstrap?grant=...",
  "view_url": "https://vite-dev-a8f2.bud.show/",
  "expires_at": "2026-05-12T12:05:00.000Z"
}
```

## Bootstrap Route

Add gateway route:

```http
GET /__bud/bootstrap?grant=<opaque>&to=<path>
```

Behavior:

- Resolve the endpoint host to a proxied site.
- Hash and consume the grant.
- Verify grant site/host/user match.
- Verify site is enabled, unexpired, private-owner, and Bud-owned by the grant
  user.
- Create `proxied_site_viewer_session`.
- Set proxy viewer cookie.
- Redirect to the requested endpoint path, default `/`.

Cookie behavior:

- Host-only cookie on the endpoint host.
- `Path=/`.
- `HttpOnly`.
- `Secure` in production.
- `SameSite=None` for iframe compatibility.
- 7-day max age.
- Refresh after roughly 1 day if the backing Better Auth session is still valid.
- Consider adding a parallel `Partitioned` cookie where supported for Chrome
  iframe resilience. Keep the top-level fallback as the guaranteed path.

Local HTTP caveat:

- Local development cannot fully exercise production `Secure` cookie behavior
  without HTTPS. The first pass should still support HTTP local bootstrap for
  developer iteration and document that production cookie behavior is validated
  in deployed or HTTPS-like environments.

## Gateway Request Authorization

For every proxied request:

1. Resolve endpoint host to `proxied_site`.
2. Reject missing, disabled, expired, or unsupported access policy.
3. Resolve and validate viewer cookie.
4. Verify session user still owns the Bud/site.
5. Verify the Bud daemon is connected and supports proxy capability.
6. Only then allocate gateway/daemon proxy state.

Errors:

- Unknown endpoint host: `404`.
- Missing/invalid viewer auth: show a small private access page or return
  `401` for fetch-like requests.
- Signed-in non-owner through bootstrap: `404`.
- Bud offline: product error page or `503`.
- Site disabled/expired: product error page or `410`.

## HTTP Proxy Path

Initial methods:

- `GET`
- `HEAD`

Request handling:

- Preserve path and query exactly.
- Prefix-free endpoint hosts avoid `/proxy/:id` rewriting issues for root
  absolute paths such as `/src/main.tsx`, `/@vite/client`, `/assets/...`, and
  `/api/...`.
- Default upstream `Host` is target host/port.
- Include `X-Forwarded-Host` and `X-Forwarded-Proto`.
- Strip Bud credentials, proxy viewer cookies, and hop-by-hop headers.
- Do not forward `bud.dev` cookies.

Response handling:

- Stream status, headers, and body back to the browser.
- Strip hop-by-hop headers.
- Do not expose daemon/service internals in error bodies.
- Defer full local-app `Set-Cookie` support to Phase 4 if needed, but reserve
  gateway auth cookie names immediately.

## Daemon Responsibilities

For every proxied request, daemon must:

- Validate target host against loopback-only policy.
- Resolve `localhost` and verify every resolved address is loopback.
- Reject redirects or target rewrites that attempt to reach non-loopback hosts.
- Apply connection and response timeouts.
- Return normalized errors to service.

If the daemon capability does not yet include a web proxy flag, add one before
enabling the gateway for a Bud.

## Tests

Add tests for:

- Bootstrap grant can only be minted by owner.
- Grant expires and is one-time use.
- Bootstrap host must match proxied site endpoint host.
- Viewer cookie allows private access only to the owning site.
- Viewer cookie cannot be overwritten by local-app `Set-Cookie` reserved names.
- Gateway rejects before opening a daemon stream when auth is missing.
- Gateway rejects disabled, expired, and unknown endpoint hosts.
- Path and query are preserved for root-absolute assets.
- `bud.dev` cookies are not forwarded upstream.
- Upstream `Host` defaults to target host/port.
- Daemon offline returns product-safe error.

## Spec Files To Update During Implementation

- `service/src/proxy/proxy.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `bud/src/src.spec.md` if daemon proxy request handling changes
- `docs/proto.md` for new daemon proxy frames/capabilities

## Acceptance Criteria

- Owner can open a simple `GET`/`HEAD` local app page through an endpoint host.
- Root-absolute asset URLs resolve on the same endpoint host.
- Gateway auth is cookie-backed and works without custom navigation headers.
- Unauthorized requests fail before daemon proxy allocation.
- Local development can exercise the full route without HTTPS.
- Production configuration supports `bud.dev` and `*.bud.show` separation.
