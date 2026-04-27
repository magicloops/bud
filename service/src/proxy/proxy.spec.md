# proxy

Browser-facing localhost proxy runtime for Phase 4 of the daemon network upgrade.

## Purpose

This folder owns service-side localhost proxy sessions and the Phase 4.2 GET/HEAD streaming bridge. Browser-created proxy sessions are user-owned, Bud-scoped, short-lived, localhost-only, revocable, auditable, and fail closed unless the Bud has active gRPC control plus a negotiated HTTP/2 data stream.

## Files

### `proxy-session.ts`

Proxy session helpers and route-facing contracts.

- validates proxy targets as explicit `http://127.0.0.1:<port>` only
- normalizes allowed methods, defaulting to `GET` and `HEAD`
- resolves whether the Bud has active authenticated `h2_grpc` control and subordinate `h2_data` with `localhost_http_proxy` negotiated
- creates owned `proxy_session` rows with TTL, audit correlation id, display metadata, and transport degraded state
- records `proxy.session_create` and `proxy.session_revoke` audit events
- reads and lists sessions with SQL owner filters
- serializes the stable browser REST response shape

### `proxy-edge.ts`

Browser-facing proxy edge implementation.

- authorizes an owned proxy session before opening daemon work
- supports `GET` and `HEAD` over `BudControl.Connect` plus `BudData.Attach`
- creates durable `bud_operation` and `bud_stream` rows for each request
- sends `proxy_open` metadata over gRPC control
- streams daemon response chunks into the Fastify reply body
- maps daemon open rejection, timeout, transport loss, and client close to typed HTTP/durable states
- tolerates tiny responses where data-stream close arrives before control-stream state transitions finish
- sanitizes request and response headers

### `proxy-runtime.ts`

In-memory bridge between daemon `proxy_open_result` / generic stream frames and one active HTTP response.

- waits for daemon accept/reject
- writes `stream_data` chunks to a `PassThrough`
- turns reset/close frames into HTTP stream completion or failure
- deletes the runtime registration when the stream closes or resets

### `proxy-session.test.ts`

Focused unit coverage for target validation, method normalization, and gRPC control/data transport readiness checks.

### `proxy-runtime.test.ts`

Focused unit coverage for open-result delivery and response-body chunk handling.

## Dependencies

- [../db/db.spec.md](../db/db.spec.md) - `proxy_session` schema and audit rows
- [../routes/routes.spec.md](../routes/routes.spec.md) - REST route registration and browser-visible behavior
- [../transport/transport.spec.md](../transport/transport.spec.md) - gRPC control/data tracker state used for readiness
- [../../../plan/network-upgrade/phase-4-localhost-proxy-and-file-reads.md](../../../plan/network-upgrade/phase-4-localhost-proxy-and-file-reads.md) - Phase 4 sequencing

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Later Phase 4 work still needs request bodies/non-GET methods, local web proxy validation, daemon file streaming behind the new file-session contract, richer audit events for every stream close/reset outcome, and public hardening of device credentials before external exposure.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
