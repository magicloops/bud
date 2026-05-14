# proxy

Browser-facing localhost proxy runtime for Phase 4 of the daemon network upgrade and the product web-proxy gateway.

## Purpose

This folder owns service-side localhost proxy sessions, durable product proxied-site helpers, the HTTP streaming bridge with bounded request-body support, and the product WebSocket proxy bridge used by local-dev HMR. Browser-created proxy sessions are user-owned, Bud-scoped, short-lived, localhost-only, revocable, auditable, and fail closed unless the Bud has an active data-plane carrier with localhost proxy support. Product proxied sites are longer-lived owner-private resources with generated endpoint hosts and cookie-backed viewer access.

## Files

### `proxy-session.ts`

Proxy session helpers and route-facing contracts.

- validates proxy targets as loopback `localhost`, `127.0.0.1`, or `::1`
- normalizes allowed methods, defaulting to the Phase 4a common method set
- resolves whether the Bud has an active WebSocket/HTTP2 data-plane carrier with `localhost_http_proxy` negotiated
- resolves whether the Bud has an active WebSocket-capable carrier with `localhost_websocket_proxy` negotiated
- creates owned `proxy_session` rows with TTL, audit correlation id, display metadata, and transport degraded state
- records `proxy.session_create` and `proxy.session_revoke` audit events
- reads and lists sessions with SQL owner filters
- serializes the stable browser REST response shape, including carrier health, candidate transports, and selection reason for operator debugging

### `proxied-site.ts`

Product web-proxy resource helpers and route-facing contracts.

- validates product proxy targets as `127.0.0.1`, `::1`, or exact `localhost`
- defaults product proxied-site creation to exact `localhost` when callers omit
  `target_host`
- allocates generated-friendly endpoint hosts beneath the configured proxy base domain
- creates or reuses owned durable `proxied_site` rows with soft TTL renewal metadata
- reads, lists, updates, disables, attaches, and detaches proxied sites with SQL owner filters
- creates short-lived one-time viewer grants and hashed endpoint-host viewer sessions
- builds host-only `HttpOnly` viewer cookies with 7-day max age and roughly 1-day Better Auth refresh checks
- serializes the stable product response shape consumed by the web view tab and agent web-view tools, including separate HTTP proxy and WebSocket/HMR transport readiness
- closes active proxied WebSocket runtime sessions when a durable proxied site is disabled

### `proxy-edge.ts`

Browser-facing proxy edge implementation.

- authorizes an owned proxy session before opening daemon work
- supports `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`
  over the selected carrier's control and data sides
- buffers request bodies under `PROXY_SESSION_MAX_REQUEST_BODY_BYTES`, sends
  `request_body_bytes` on `proxy_open`, and forwards body bytes as same-stream
  `stream_data` frames before waiting for daemon accept/reject
- creates durable `bud_operation` and `bud_stream` rows for each request
- enforces per-Bud proxy stream concurrency, per-stream idle/TTL limits, max chunk/credit windows, and the service-side proxy response byte ceiling
- sends `proxy_open` metadata over the selected carrier's control side
- forwards endpoint-host local-app cookies for durable proxied-site requests
  after stripping proxy viewer and reserved Bud proxy cookies; raw `/api/proxy`
  sessions continue to omit cookies
- streams daemon response chunks into the Fastify reply body
- filters daemon `proxy_open_result.set_cookies` before browser emission,
  stripping `Domain`, enforcing cookie caps, and rejecting reserved proxy
  cookie names/prefixes
- maps daemon open rejection, timeout, transport loss, and client close to typed HTTP/durable states
- fails and resets durable state when carrier send throws or when an accepted daemon open-result omits the required HTTP status code
- records stream-open and service/daemon denial audit events with selected carrier metadata
- sanitizes request and response headers
- also opens durable `proxied_site` requests by adapting the product resource into the existing daemon `proxy_open` stream contract

### `proxy-runtime.ts`

In-memory bridge between daemon `proxy_open_result` / generic stream frames and one active HTTP response.

- waits for daemon accept/reject
- preserves out-of-band `set_cookies` arrays on accepted HTTP opens so the
  edge can emit multi-valued `Set-Cookie` headers without comma-joining
- writes `stream_data` chunks to a `PassThrough`
- enforces the configured service-side max received byte count before forwarding chunks to the browser
- turns reset/close frames into HTTP stream completion or failure
- deletes the runtime registration when the stream closes or resets

### `proxy-ws-edge.ts`

Browser-facing endpoint-host WebSocket bridge for durable proxied sites.

- validates proxy-domain viewer auth before daemon work allocation
- selects the `localhost_websocket_proxy` carrier family
- enforces per-site and per-Bud active WebSocket limits plus open and idle timeouts
- creates durable `bud_operation` / `bud_stream` rows for accepted upgrade work
- sends `proxy_ws_open` to Bud and bridges browser text/binary frames through `proxy_ws_message`
- buffers a small bounded set of browser messages that arrive after browser upgrade but before Bud accepts the local WebSocket open
- propagates browser, daemon, service-timeout, and transport-loss closes through typed `proxy_ws_close` / `proxy_ws_error` behavior
- closes active browser/daemon WebSockets when the durable site expires during an open connection
- cleans up active runtime state and durable `proxied_site.active_stream_id` on close/reset

### `proxy-ws-runtime.ts`

In-memory runtime for active proxied WebSocket sessions.

- tracks active sessions by `ws_session_id`
- waits for daemon `proxy_ws_open_result`
- forwards daemon `proxy_ws_message`, `proxy_ws_close`, and `proxy_ws_error` frames to browser sockets
- forwards browser messages/closes to daemon proxy WebSocket frames
- enforces the configured proxied WebSocket message-size ceiling
- exposes per-site and per-Bud active counts for gateway limits
- exposes service-side helpers to close all active sessions for a disabled/expired site or Bud-level transport loss

### `proxy-session.test.ts`

Focused unit coverage for target validation, method normalization, carrier-neutral transport readiness checks, and selected-carrier health metadata.

### `proxied-site.test.ts`

Focused unit coverage for product target/path validation, endpoint host generation, and viewer cookie parsing.

### `proxy-runtime.test.ts`

Focused unit coverage for open-result delivery and response-body chunk handling.

### `proxy-edge.test.ts`

Focused unit coverage for proxy request body extraction, request-body error
handling before daemon work allocation, endpoint-host request-cookie filtering,
and response `Set-Cookie` filtering/caps.

### `proxy-ws-runtime.test.ts`

Focused unit coverage for proxied WebSocket text/binary forwarding, daemon open/close dispatch, oversized browser-frame rejection, and active-session cleanup helpers used by disabled/expired sites and Bud-level transport loss.

## Dependencies

- [../db/db.spec.md](../db/db.spec.md) - `proxy_session`, `proxied_site`, `thread_web_view`, viewer grant/session schema, and audit rows
- [../routes/routes.spec.md](../routes/routes.spec.md) - REST route registration and browser-visible behavior
- [../transport/transport.spec.md](../transport/transport.spec.md) - data-plane carrier selection and stream runtime
- [../../../plan/swappable-transport/phase-1-carrier-neutral-data-plane-runtime.md](../../../plan/swappable-transport/phase-1-carrier-neutral-data-plane-runtime.md) - carrier-neutral runtime sequencing

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Later proxy work still needs redirect rewriting, optional streaming uploads
  beyond the bounded-buffer path, WebSocket subprotocol selection parity for
  browsers that require it, and public hardening before broader external
  exposure.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
