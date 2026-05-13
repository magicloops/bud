# Phase 4: HTTP Fidelity, Request Bodies, And Cookies

## Objective

Move from read-only page rendering to interactive local apps. After this phase,
proxied sites support common HTTP methods, request bodies, local app cookies,
redirects, and enough response streaming to make typical dev apps usable beyond
initial render.

## Scope

- Add proxy request body support from browser to gateway to daemon to local
  server.
- Expand allowed methods.
- Implement local app cookie forwarding and `Set-Cookie` filtering.
- Finalize header policy and redirect behavior.
- Add size limits, timeouts, and structured errors.
- Update Bud-service protocol docs for body frames.

## Non-Goals

- No browser WebSocket/HMR yet.
- No arbitrary upstream hosts.
- No true unbounded streaming uploads.
- No public sharing.

## Allowed Methods

Allow:

- `GET`
- `HEAD`
- `POST`
- `PUT`
- `PATCH`
- `DELETE`
- `OPTIONS`

Reject:

- `CONNECT`
- `TRACE`

Unknown methods remain rejected until there is a concrete need.

## Request Body Policy

First body phase:

- Buffer request bodies up to 10 MB.
- Support common text, JSON, form, multipart, and binary content types under
  the same size cap.
- Reject bodies over the cap with a product-safe `413`.
- Preserve `Content-Type` where safe.
- Recompute or normalize `Content-Length` rather than trusting browser/gateway
  forwarded values.
- Do not support streaming uploads until a later phase.

Future extension:

- Add streaming body frames if large uploads or long-lived request streams
  become necessary.

## Header Policy

Strip request headers:

- `connection`
- `upgrade` in this phase
- `proxy-authenticate`
- `proxy-authorization`
- `te`
- `trailer`
- `transfer-encoding`
- `keep-alive`
- Bud app auth headers or cookies
- proxy viewer cookies before forwarding to local target

Set or forward:

- Upstream `Host`: target host/port by default.
- `X-Forwarded-Host`: endpoint host.
- `X-Forwarded-Proto`: public scheme.
- `X-Forwarded-For`: only if product/security review wants the browser IP
  visible to local apps; otherwise omit to reduce local app fingerprinting.

Response headers:

- Strip hop-by-hop headers.
- Preserve cache headers unless they expose internal gateway state.
- Preserve content type, content length when known, ETag, and other normal app
  headers where safe.
- Avoid injecting permissive CORS headers. The local app should see its own
  endpoint host as origin.

## Cookie Policy

Request cookies:

- Do not forward `bud.dev` cookies.
- Do not forward proxy viewer cookies.
- Forward endpoint-host local app cookies to the local app.
- Apply count and total-size caps before forwarding.

Response cookies:

- Allow local apps to set endpoint-host cookies.
- Strip or rewrite `Domain` so cookies remain host-only for the endpoint host.
- Preserve path, max-age/expires, secure, httponly, and samesite where safe.
- Strip any local-app `Set-Cookie` that attempts to use reserved gateway cookie
  names or prefixes.
- Consider rejecting cookies that exceed configured count or size limits.

Pros of allowing endpoint-host local app cookies:

- Many development apps rely on session cookies after login.
- Cookies are isolated to the generated `bud.show` endpoint host, not `bud.dev`.
- Bookmarkable proxied sites behave more like real hosted apps.

Risks and mitigations:

- Local apps can track state within that endpoint host. This is expected because
  the owner chose to proxy that local app.
- Local apps could try to overwrite gateway auth. Reserved names and host-only
  viewer cookies prevent this.
- Cookie bloat can hurt gateway performance. Enforce caps.

## Redirects

Default behavior:

- Preserve relative redirects.
- Rewrite absolute redirects that point at the same local target back to the
  endpoint host.
- Block or pass through external redirects only after a product decision.

Recommended first pass:

- For `Location: http://127.0.0.1:5173/foo`, rewrite to
  `https://<endpoint>.bud.show/foo`.
- For relative `Location: /foo`, leave as `/foo`.
- For external `Location: https://example.com`, pass through only if that is
  consistent with browser expectations and does not leak proxy credentials.

## Daemon Protocol Work

Add or extend frames for:

- request method
- path/query
- request headers after service filtering
- body bytes or body chunks
- response status
- response headers
- response body chunks
- normalized local-network errors
- cancellation when the browser disconnects

Protocol invariants:

- Preserve existing top-level frame envelope conventions.
- Use `snake_case` wire fields.
- Enforce chunk size limits consistent with existing daemon output contracts
  where practical.
- Support cancellation so uploads/downloads do not continue after browser
  disconnect.

## Limits And Timeouts

Suggested defaults:

- Request body cap: 10 MB.
- Response header timeout: 30 seconds.
- Idle response timeout: 60 seconds.
- Max response body for buffered paths: avoid buffering; stream where possible.
- Per-site concurrent HTTP requests: low default such as 32 until measured.
- Per-Bud concurrent HTTP requests: configurable global cap.

## Tests

Add tests for:

- JSON `POST` reaches a local test server.
- Form and multipart bodies under 10 MB are forwarded.
- Oversized body returns `413`.
- `DELETE` and `OPTIONS` behave as expected.
- `CONNECT` and `TRACE` are rejected.
- Browser disconnect cancels daemon/local request.
- Local app cookies round-trip on endpoint host.
- Reserved gateway cookie names cannot be set by local app.
- `bud.dev` cookies never reach local app.
- Redirects to local target are rewritten to endpoint host.
- Header stripping removes hop-by-hop and proxy auth headers.

## Spec Files To Update During Implementation

- `docs/proto.md`
- `service/src/proxy/proxy.spec.md`
- `bud/src/src.spec.md`
- relevant route/runtime specs for cancellation and limits

## Acceptance Criteria

- Common local app mutation APIs work through the proxy.
- Endpoint-host local app cookies work without exposing Bud credentials.
- Gateway and daemon enforce body size, method, timeout, and header policies.
- Redirect behavior keeps localhost URLs usable behind endpoint hosts.
- Protocol docs and tests cover request bodies and cancellation.
