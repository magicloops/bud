# Mobile Hand-Off: Web Proxy And Local HTTPS

## Purpose

This hand-off gives mobile developers the product contract, local runbook, and
API flow for Bud web proxying on this branch. The goal is that mobile can run
the same local HTTPS stack as web/service/daemon developers and update the app
without needing to reverse-engineer the current web UI implementation.

## Feature Summary

Bud web proxying lets an authenticated Bud owner view a web server running on
the same host as the Bud daemon. The proxied site is a durable Bud-owned
resource, not a thread-owned preview session.

Core concepts:

- `proxied_site`: long-lived Bud-owned local target such as
  `localhost:5173`.
- `thread_web_view`: optional attachment from one thread to one proxied site.
- viewer grant: short-lived one-time bootstrap token minted by the app/API
  origin.
- viewer cookie: endpoint-host cookie set by the proxy host after bootstrap.
- endpoint host: isolated proxy origin for local app content.

First-pass access policy is private owner-only. Mobile should assume only the
signed-in Bud owner can create, list, attach, and open these sites.

## Production Shape

Planned production origin split:

```text
App/API/auth:      https://bud.dev
Proxy content:     https://<slug>.bud.show
Bud daemon WSS:    wss://bud.dev/ws
```

Mobile should not inject bearer headers into proxied page navigation or
subresource requests. The supported auth model is:

1. use the normal authenticated Bud API session on the app/API origin
2. request a viewer grant
3. open the returned bootstrap URL in a hosted web view
4. let the proxy endpoint host set and refresh its own cookie

## Local HTTPS Shape

The default local stack can still run over plain HTTP. For web-proxy mobile
work, use the optional mkcert+Caddy HTTPS profile because it matches the
production cookie and WebSocket behavior more closely.

Local HTTPS origins:

```text
App/API/auth/SSE:  https://localhost:3443
Bud daemon WSS:    wss://localhost:3443/ws
Proxy content:     https://<slug>.bud-show.test:3443
```

Caddy routes:

```text
https://localhost:3443
  /api/*          -> service at http://127.0.0.1:3000
  /.well-known/*  -> service at http://127.0.0.1:3000
  /ws             -> service at http://127.0.0.1:3000
  everything else -> web at http://localhost:5173

https://*.bud-show.test:3443
  all traffic     -> service proxy gateway at http://127.0.0.1:3000
                     with the browser Host header preserved
```

Validated on this branch:

- Better Auth callbacks through `https://localhost:3443`
- API, SSE, and Bud WSS through Caddy
- proxy host preservation into Fastify
- embedded web-view bootstrap with a secure endpoint-host viewer cookie
- proxied Vite app loading and HMR through the proxy endpoint host

## Local Setup

Install local HTTPS tools once:

```bash
brew install mkcert caddy dnsmasq
mkcert -install
```

Configure local wildcard DNS for proxy endpoints:

```bash
mkdir -p "$(brew --prefix)/etc/dnsmasq.d"
printf 'port=53\nlisten-address=127.0.0.1\naddress=/bud-show.test/127.0.0.1\n' > "$(brew --prefix)/etc/dnsmasq.d/bud-show.test.conf"
grep -q 'dnsmasq.d' "$(brew --prefix)/etc/dnsmasq.conf" 2>/dev/null || printf 'conf-dir=$(brew --prefix)/etc/dnsmasq.d/,*.conf\n' >> "$(brew --prefix)/etc/dnsmasq.conf"
sudo mkdir -p /etc/resolver
printf 'nameserver 127.0.0.1\n' | sudo tee /etc/resolver/test
sudo brew services restart dnsmasq
dscacheutil -q host -a name smoke.bud-show.test
```

macOS note: this `/etc/resolver/test` path expects dnsmasq on port 53. Do not
point the resolver file at a non-53 localhost dnsmasq port. If `127.0.0.1:53`
is unavailable, bind dnsmasq to a loopback alias on port 53 and use that alias
in `/etc/resolver/test`.

Generate certs from the repo root:

```bash
pnpm dev:https:setup
```

Use the HTTPS env profiles:

```bash
cp service/.env.https.example service/.env
cp web/.env.https.example web/.env
cp bud/.env.https.example bud/.env
```

Fill secrets in `service/.env`, especially database, Better Auth secret, OAuth
credentials, and model provider keys as needed.

Provision or refresh the local iOS OAuth client after the HTTPS env values are
in place:

```bash
pnpm dev:https:provision-ios
```

For this HTTPS profile, the printed bundle should use:

```text
app_origin: https://localhost:3443
issuer: https://localhost:3443/api/auth
audience: https://localhost:3443/api
```

If the bundle still prints `http://localhost:5173`, the service is still using
the default HTTP env profile. Switch `service/.env` to the HTTPS values and run
the provisioning script again before handing the bundle to mobile.

If Better Auth logs `Failed to decrypt private key` after switching env
profiles, keep the original `BETTER_AUTH_SECRET` or clear local `auth.jwks`
rows and sign in again. Existing JWKS private keys are encrypted with the
secret that was active when they were generated.

Local Google OAuth configuration:

```text
Authorized JavaScript origin:
https://localhost:3443

Redirect URI:
https://localhost:3443/api/auth/callback/google
```

Local GitHub OAuth callback:

```text
https://localhost:3443/api/auth/callback/github
```

Run the stack:

```bash
pnpm dev:https

cd bud
set -a; source .env; set +a
cargo run -- --terminal-enabled
```

Open the product at:

```text
https://localhost:3443
```

If `https://localhost:3443` returns a Caddy 502 for `/`, confirm the Vite web
server is running at `http://localhost:5173`. If API or daemon connection
routes fail, confirm service is running at `http://127.0.0.1:3000`.

## Mobile Simulator Notes

The local HTTPS profile is easiest when the mobile app runs in an iOS
Simulator on the same Mac as the Bud stack:

- the simulator can reach the Mac's `localhost`
- `https://localhost:3443` should be the local app/API/auth origin
- proxy URLs use `https://<slug>.bud-show.test:3443`
- the mkcert root CA must be trusted by the environment hosting the web view
- `smoke.bud-show.test` must resolve to `127.0.0.1` through system DNS

Validation note: confirm the target simulator and web-view stack both trust the
mkcert root and resolve wildcard `*.bud-show.test`. If either fails, use the
desktop web flow for feature work and track a simulator-specific trust/DNS
fallback before declaring mobile local HTTPS complete.

Physical-device testing is not solved by the local `localhost` profile because
the phone's `localhost` is the phone, not the Mac. For physical devices, use a
separate LAN-oriented profile or deployed/staging environment. Do not try to
paper over that with custom subresource auth headers in the proxied web view.

## API Flow For Mobile

All API calls below are made against the app/API origin with the existing
authenticated Bud session:

```text
Local HTTPS: https://localhost:3443
Production:  https://bud.dev
```

### 1. List Bud Proxied Sites

```http
GET /api/buds/:bud_id/proxied-sites
```

Response:

```json
{
  "proxied_sites": [],
  "transport": { "available": true },
  "websocket_transport": { "available": true }
}
```

### 2. Create Or Reuse A Site

```http
POST /api/buds/:bud_id/proxied-sites
Content-Type: application/json
```

Body:

```json
{
  "target_host": "localhost",
  "target_port": 5173,
  "path": "/",
  "title": "Local app",
  "reuse_existing": true,
  "source": "manual"
}
```

`target_host` is optional. If omitted, the service defaults to exact
`localhost`. If the user or app explicitly chooses `localhost`, `127.0.0.1`, or
`::1`, preserve that exact value.

Response:

```json
{
  "proxied_site_id": "site_...",
  "bud_id": "b_...",
  "display_name": "Local app",
  "slug": "local-app-ab12cd",
  "endpoint_host": "local-app-ab12cd.bud-show.test",
  "view_url": "https://local-app-ab12cd.bud-show.test:3443/",
  "target_host": "localhost",
  "target_port": 5173,
  "path": "/",
  "access_policy": "private_owner",
  "enabled": true,
  "state": "ready",
  "expires_at": "2026-08-14T12:00:00.000Z",
  "transport": { "available": true },
  "websocket_transport": { "available": true },
  "capabilities": { "websocket": true },
  "created_at": "2026-05-16T12:00:00.000Z",
  "updated_at": "2026-05-16T12:00:00.000Z"
}
```

### 3. Attach Site To Thread

```http
POST /api/threads/:thread_id/web-view/attach
Content-Type: application/json
```

Body:

```json
{
  "proxied_site_id": "site_...",
  "path": "/"
}
```

The attachment is a convenience for thread context. It does not own the site
lifecycle.

### 4. Read Current Thread Web View

```http
GET /api/threads/:thread_id/web-view
```

Response when attached:

```json
{
  "web_view": {
    "thread_id": "thread_...",
    "bud_id": "b_...",
    "proxied_site_id": "site_...",
    "selected_path": "/",
    "created_at": "2026-05-16T12:00:00.000Z",
    "updated_at": "2026-05-16T12:00:00.000Z",
    "proxied_site": {
      "proxied_site_id": "site_...",
      "view_url": "https://local-app-ab12cd.bud-show.test:3443/",
      "state": "ready"
    }
  }
}
```

Response when unattached:

```json
{ "web_view": null }
```

### 5. Request A Viewer Grant

```http
POST /api/proxied-sites/:proxied_site_id/viewer-grants
Content-Type: application/json
```

Body:

```json
{ "path": "/" }
```

Response:

```json
{
  "bootstrap_url": "https://local-app-ab12cd.bud-show.test:3443/__bud/bootstrap?grant=...&to=%2F",
  "view_url": "https://local-app-ab12cd.bud-show.test:3443/",
  "expires_at": "2026-05-16T12:05:00.000Z"
}
```

Open `bootstrap_url` in the mobile hosted web view. Do not expose the grant in
copyable UI. It is short-lived and one-time use.

The bootstrap request should:

1. consume the grant
2. set the proxy viewer cookie on the endpoint host
3. redirect to the clean `view_url` path

For local HTTPS, the viewer cookie is expected to be host-only, `HttpOnly`,
`Secure`, and `SameSite=None` using the configured
`__Host-bud_proxy_viewer` cookie name.

### 6. Detach Or Disable

Detach the thread without disabling the durable site:

```http
DELETE /api/threads/:thread_id/web-view
```

Disable a durable site:

```http
DELETE /api/proxied-sites/:proxied_site_id
```

Mobile should treat these as separate actions. Closing a web-view surface
should normally detach or dismiss UI, not disable the site, unless the user
explicitly chooses to stop the proxied site.

## Native Web View Expectations

Recommended behavior:

- Open the returned `bootstrap_url` as a normal navigation.
- Let the web view follow redirects and store endpoint-host cookies.
- Reuse normal web-view cookie behavior for subsequent subresources,
  WebSockets, and reloads.
- Use the app/API authenticated session only for API calls that mint grants or
  manage sites.

Avoid:

- injecting Bearer tokens into local app navigations
- rewriting all subresource requests natively
- sharing app-origin cookies with proxy endpoint hosts manually
- exposing raw grant URLs in long-lived logs or user-copyable fields

## Error And State Handling

Important site states:

- `ready`: site can be opened if daemon transport is available
- `disabled`: owner disabled the site
- `expired`: long-lived soft TTL expired

Transport fields:

- `transport.available`: HTTP proxy path availability
- `websocket_transport.available`: WebSocket/HMR path availability
- `capabilities.websocket`: whether the site can support WebSocket proxying

Current first-pass product behavior:

- unauthenticated API requests return `401`
- signed-in non-owner API requests return `404`
- disabled gateway traffic returns a disabled error
- expired gateway traffic returns an expired error
- unavailable daemon transport returns a typed transport-unavailable response

Follow-on product work will improve mobile-visible pages for local connect
failure, connection limit exceeded, open timeout, and transport loss. Mobile
should still reserve UI space for these states rather than treating every
failure as a generic web-view crash.

## Security Boundaries

Mobile should preserve these invariants:

- create/list/read/attach through authenticated owner-scoped API routes only
- do not pass raw `bud_id`, `thread_id`, or `proxied_site_id` across security
  boundaries without letting the service re-authorize
- never forward Bud app cookies or auth headers to the local app
- only support loopback local targets: `localhost`, `127.0.0.1`, `::1`
- do not invent public sharing, password access, or shared-Bud ACL behavior in
  the mobile client
- do not store or display viewer grants beyond the immediate navigation

## Mobile Implementation Checklist

- [ ] Add config for local HTTPS app/API origin:
  `https://localhost:3443`.
- [ ] Add web-proxy API client methods for create/list/read/attach/detach and
  viewer grants.
- [ ] Open `bootstrap_url` in a hosted web-view surface.
- [ ] Verify endpoint-host cookies persist in the chosen iOS web-view
  configuration.
- [ ] Verify proxied HTTP pages and WebSocket/HMR pages load in simulator.
- [ ] Add owner-facing states for offline, disabled, expired, auth blocked,
  local connect failed, connection limit, open timeout, and transport lost.
- [ ] Keep close/dismiss separate from durable site disable.
- [ ] Avoid logging grants, cookies, request bodies, response bodies, and
  WebSocket payloads.

## Known Gaps For Mobile

- Physical-device local testing needs a LAN/deployed profile; the current
  `localhost:3443` profile is simulator/local-Mac oriented.
- Product-visible proxy error pages and typed last-error snapshots are still a
  follow-on hardening item.
- Public sharing, password protection, and friendly slug overrides are not part
  of the current private-owner flow.
- Production wildcard DNS/TLS and edge WebSocket upgrade checks are still
  tracked separately before broad rollout.

## References

- [Phase 3: Web And Mobile Client Surfaces](./phase-3-web-and-mobile-client-surfaces.md)
- [Phase 8: Local HTTPS Dev With mkcert And Caddy](./phase-8-local-https-dev.md)
- [Progress Checklist](./progress-checklist.md)
- [Validation Checklist](./validation-checklist.md)
- [Root README Local HTTPS Section](../../README.md#optional-local-https)
