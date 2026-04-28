# proxy

Browser-facing localhost proxy runtime for Phase 4 of the daemon network upgrade.

## Purpose

This folder owns service-side localhost proxy sessions and the Phase 4.2 GET/HEAD streaming bridge. Browser-created proxy sessions are user-owned, Bud-scoped, short-lived, localhost-only, revocable, auditable, and fail closed unless the Bud has an active data-plane carrier with localhost proxy support.

## Files

### `proxy-session.ts`

Proxy session helpers and route-facing contracts.

- validates proxy targets as explicit `http://127.0.0.1:<port>` only
- normalizes allowed methods, defaulting to `GET` and `HEAD`
- resolves whether the Bud has an active WebSocket/HTTP2 data-plane carrier with `localhost_http_proxy` negotiated
- creates owned `proxy_session` rows with TTL, audit correlation id, display metadata, and transport degraded state
- records `proxy.session_create` and `proxy.session_revoke` audit events
- reads and lists sessions with SQL owner filters
- serializes the stable browser REST response shape

### `proxy-edge.ts`

Browser-facing proxy edge implementation.

- authorizes an owned proxy session before opening daemon work
- supports `GET` and `HEAD` over the selected carrier's control and data sides
- creates durable `bud_operation` and `bud_stream` rows for each request
- enforces per-Bud proxy stream concurrency, per-stream idle/TTL limits, max chunk/credit windows, and the service-side proxy response byte ceiling
- sends `proxy_open` metadata over the selected carrier's control side
- streams daemon response chunks into the Fastify reply body
- maps daemon open rejection, timeout, transport loss, and client close to typed HTTP/durable states
- records stream-open and service/daemon denial audit events with selected carrier metadata
- tolerates tiny responses where data-stream close arrives before control-stream state transitions finish
- sanitizes request and response headers

### `proxy-runtime.ts`

In-memory bridge between daemon `proxy_open_result` / generic stream frames and one active HTTP response.

- waits for daemon accept/reject
- writes `stream_data` chunks to a `PassThrough`
- enforces the configured service-side max received byte count before forwarding chunks to the browser
- turns reset/close frames into HTTP stream completion or failure
- deletes the runtime registration when the stream closes or resets

### `proxy-session.test.ts`

Focused unit coverage for target validation, method normalization, and carrier-neutral transport readiness checks.

### `proxy-runtime.test.ts`

Focused unit coverage for open-result delivery and response-body chunk handling.

## Dependencies

- [../db/db.spec.md](../db/db.spec.md) - `proxy_session` schema and audit rows
- [../routes/routes.spec.md](../routes/routes.spec.md) - REST route registration and browser-visible behavior
- [../transport/transport.spec.md](../transport/transport.spec.md) - data-plane carrier selection and stream runtime
- [../../../plan/swappable-transport/phase-1-carrier-neutral-data-plane-runtime.md](../../../plan/swappable-transport/phase-1-carrier-neutral-data-plane-runtime.md) - carrier-neutral runtime sequencing

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Later proxy work still needs request bodies/non-GET methods, product web proxy validation, optional browser WebSocket upgrade policy, and public hardening of device credentials before external exposure.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
