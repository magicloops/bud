# Phase 4b: Endpoint-Host Local App Cookies

## Objective

Make private proxied sites behave like normal hosted local apps for cookie-based
state, while keeping Bud app credentials and proxy viewer auth isolated from the
local target.

## Scope

- Forward endpoint-host local-app request cookies for durable proxied-site
  gateway requests.
- Continue stripping Bud app/API cookies, auth headers, hop-by-hop headers, and
  proxy viewer cookies before daemon/local target forwarding.
- Add a distinct `set_cookies` array to `proxy_open_result` so daemon can
  preserve multiple local `Set-Cookie` headers.
- Filter local app `Set-Cookie` values at the service edge:
  - strip `Domain` so cookies stay host-only on the endpoint host
  - reject reserved Bud proxy cookie names and prefixes
  - reject newline-containing values
  - enforce count and total byte caps
- Keep local-app cookies disabled for raw `/api/proxy/:proxySessionId/*`
  sessions because that route is on the Bud app/API origin.

## Non-Goals

- No redirect `Location` rewriting; that remains Phase 4c.
- No public/shared proxy cookie policy.
- No arbitrary upstream hosts.
- No local HTTPS parity changes; that remains Phase 8.
- No streaming upload changes.
- No WebSocket request-cookie forwarding; this phase covers HTTP proxy
  requests only.

## Design

The service owns product/browser cookie policy. The daemon is allowed to return
the local server's raw `Set-Cookie` headers as metadata, but browser-visible
cookies are only emitted after service filtering.

Request cookies only flow on durable endpoint-host proxied-site requests. The
service parses the browser `Cookie` header, removes the proxy viewer cookie and
reserved Bud proxy cookie prefixes, caps the remaining pairs, and forwards the
filtered `cookie` header through `proxy_open.headers`. Raw app/API proxy
sessions continue to omit cookies entirely.

Response cookies are not placed in the general response header map because
`Set-Cookie` is multi-valued and must never be comma-joined. The daemon returns
`proxy_open_result.set_cookies: string[]`. The service filters that array before
calling `reply.header("Set-Cookie", filteredCookies)`.

Reserved names/prefixes:

- active `config.proxyViewerCookieName`
- `bud_proxy_viewer`
- `__Host-bud_proxy_viewer`
- `__Secure-bud_proxy_viewer`
- `bud_proxy_*`
- `__Host-bud_proxy_*`
- `__Secure-bud_proxy_*`

## Security Notes

- `bud.dev` cookies are not forwarded because only endpoint-host gateway
  requests can pass request cookies to the daemon.
- The proxy viewer cookie is consumed by the gateway for auth and then stripped
  from upstream local requests.
- Host-only local-app cookies isolate state to the generated endpoint host,
  avoiding cross-site leakage across Bud app/API and other proxied sites.
- Cookie caps prevent a local app from using the gateway as an unbounded header
  amplifier.

## Test Plan

- Service unit tests for request-cookie filtering:
  - forwards ordinary endpoint-host app cookies
  - strips proxy viewer and reserved Bud proxy cookies
  - rejects excessive cookie count/bytes
- Service unit tests for response `Set-Cookie` filtering:
  - strips `Domain`
  - preserves safe attributes
  - rejects reserved names and newline-containing values
  - enforces count/byte caps
- Runtime test that `proxy_open_result.set_cookies` is parsed and preserved.
- Daemon unit test that `cookie` is in the request header allowlist.
- Focused TypeScript/Rust checks for the touched proxy paths.

## Acceptance Criteria

- Endpoint-host local-app cookies round-trip through a durable proxied site.
- Proxy viewer cookies and Bud app/API cookies never reach the local target.
- Local apps cannot overwrite reserved proxy viewer cookie names.
- `Set-Cookie` headers are never comma-joined or routed through the ordinary
  response header map.
- Protocol docs and touched specs describe the cookie boundary.
