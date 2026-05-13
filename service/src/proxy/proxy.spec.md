# proxy

Browser-facing localhost proxy runtime for Phase 4 of the daemon network upgrade and the product web-proxy gateway.

## Purpose

This folder owns service-side localhost proxy sessions, durable product proxied-site helpers, and the GET/HEAD streaming bridge. Browser-created proxy sessions are user-owned, Bud-scoped, short-lived, localhost-only, revocable, auditable, and fail closed unless the Bud has an active data-plane carrier with localhost proxy support. Product proxied sites are longer-lived owner-private resources with generated endpoint hosts and cookie-backed viewer access.

## Files

### `proxy-session.ts`

Proxy session helpers and route-facing contracts.

- validates proxy targets as explicit `http://127.0.0.1:<port>` only
- normalizes allowed methods, defaulting to `GET` and `HEAD`
- resolves whether the Bud has an active WebSocket/HTTP2 data-plane carrier with `localhost_http_proxy` negotiated
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
- serializes the stable product response shape consumed by the web view tab and agent web-view tools

### `proxy-edge.ts`

Browser-facing proxy edge implementation.

- authorizes an owned proxy session before opening daemon work
- supports `GET` and `HEAD` over the selected carrier's control and data sides
- creates durable `bud_operation` and `bud_stream` rows for each request
- enforces per-Bud proxy stream concurrency, per-stream idle/TTL limits, max chunk/credit windows, and the service-side proxy response byte ceiling
- sends `proxy_open` metadata over the selected carrier's control side
- streams daemon response chunks into the Fastify reply body
- maps daemon open rejection, timeout, transport loss, and client close to typed HTTP/durable states
- fails and resets durable state when carrier send throws or when an accepted daemon open-result omits the required HTTP status code
- records stream-open and service/daemon denial audit events with selected carrier metadata
- sanitizes request and response headers
- also opens durable `proxied_site` requests by adapting the product resource into the existing daemon `proxy_open` stream contract

### `proxy-runtime.ts`

In-memory bridge between daemon `proxy_open_result` / generic stream frames and one active HTTP response.

- waits for daemon accept/reject
- writes `stream_data` chunks to a `PassThrough`
- enforces the configured service-side max received byte count before forwarding chunks to the browser
- turns reset/close frames into HTTP stream completion or failure
- deletes the runtime registration when the stream closes or resets

### `proxy-session.test.ts`

Focused unit coverage for target validation, method normalization, carrier-neutral transport readiness checks, and selected-carrier health metadata.

### `proxied-site.test.ts`

Focused unit coverage for product target/path validation, endpoint host generation, and viewer cookie parsing.

### `proxy-runtime.test.ts`

Focused unit coverage for open-result delivery and response-body chunk handling.

## Dependencies

- [../db/db.spec.md](../db/db.spec.md) - `proxy_session`, `proxied_site`, `thread_web_view`, viewer grant/session schema, and audit rows
- [../routes/routes.spec.md](../routes/routes.spec.md) - REST route registration and browser-visible behavior
- [../transport/transport.spec.md](../transport/transport.spec.md) - data-plane carrier selection and stream runtime
- [../../../plan/swappable-transport/phase-1-carrier-neutral-data-plane-runtime.md](../../../plan/swappable-transport/phase-1-carrier-neutral-data-plane-runtime.md) - carrier-neutral runtime sequencing

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Later proxy work still needs request bodies/non-GET methods, endpoint-host local app cookies, optional browser WebSocket/HMR upgrade policy, and public hardening before broader external exposure.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
