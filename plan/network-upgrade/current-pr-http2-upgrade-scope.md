# Current PR Scope: HTTP/2 Network Upgrade

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Scope reset for the current network-upgrade PR
**Follow-On Designs**: [../../design/network-upgrade-file-serving-productization.md](../../design/network-upgrade-file-serving-productization.md), [../../design/network-upgrade-quic-transport.md](../../design/network-upgrade-quic-transport.md), [../../design/network-upgrade-web-serving-productization.md](../../design/network-upgrade-web-serving-productization.md), [../../design/network-upgrade-websocket-fallback.md](../../design/network-upgrade-websocket-fallback.md)

---

## Decision

Close the current PR around the daemon-service HTTP/2 network upgrade and the shared stream foundations.

The current PR may keep the file and proxy foundation code that has already been added, including DB schema, route contracts, daemon adapters, typed payloads, and local real-daemon smoke coverage. It should not try to finish any product feature that requires frontend/user-flow work.

The follow-on feature work is split into four design tracks:

1. **File serving productization**: users can click files referenced by the agent and open them in markdown/code/text viewers.
2. **QUIC transport**: add QUIC as the preferred data stream carrier.
3. **Web serving productization**: expose local development web servers through service-owned URLs.
4. **WebSocket compatibility/fallback**: allow bounded file/web-serving bytes over WebSocket for self-hosters and constrained deployments.

## Current PR Deliverables

The current PR should close with:

- protobuf envelope and typed payload compatibility in service and daemon
- `@grpc/grpc-js` service gateway plus Rust tonic daemon control
- durable `device_session`, `transport_session`, `bud_operation`, and `bud_stream` state
- terminal output over `BudData.Attach` with HTTP/2 data fallback coverage
- generic stream data, credit, reset, and close semantics
- file session and proxy session foundations that are safe to keep but not productized
- daemon file and localhost proxy adapters that are safe to keep but not productized
- real-daemon smoke coverage proving terminal, file-stream, and proxy-stream foundations over gRPC control plus HTTP/2 data
- validation notes for deferred product and transport work

The current PR should not require:

- frontend file viewer adoption
- agent/user-facing file-open workflow completion
- QUIC transport
- WebSocket fallback for file or web-serving bytes
- web-serving product UX or broad proxy semantics
- proxy request bodies, redirects, SSE validation, or WebSocket upgrades
- final device identity hardening, as long as internal exposure and follow-up requirements are recorded

## Transport Target

The long-term stream carrier order is:

```text
QUIC data stream
  -> HTTP/2 BudData.Attach fallback
  -> bounded WebSocket compatibility fallback, if enabled
```

The current PR only needs to prove the HTTP/2 path. QUIC and WebSocket fallback should be separate follow-on changes that reuse the same envelope, stream IDs, traffic classes, credits, close, and reset semantics.

## Already-Added Proxy Foundation

It is acceptable to keep already-added proxy DB schema/routes/adapters in this PR if they remain documented as foundation work rather than a shipped web-serving product.

Before product exposure, the web-serving follow-on must still decide:

- transport selector behavior
- daemon local proxy hardening beyond loopback GET/HEAD
- route ownership and non-owner/unauthenticated tests
- request/response header policy
- redirects, SSE, request bodies, asset concurrency, and optional WebSocket upgrades
- user-visible expired/offline/denied states

## Acceptance Gate

Before merging the current PR, validate:

- local daemon connects and authenticates over HTTP/2 gRPC control
- terminal output works over HTTP/2 data and existing browser REST/SSE behavior is unchanged
- generic stream foundations are covered by unit tests
- real-daemon file/proxy smoke tests prove the stream foundation over HTTP/2 data
- file/proxy productization is explicitly deferred in docs and checklists
- QUIC transport is explicitly deferred in docs and checklists
- WebSocket fallback for file/web-serving bytes is explicitly deferred in docs and checklists
- protocol docs, specs, DB specs, migrations, and validation checklists match shipped behavior

## Open Questions For Follow-On Work

- Which frontend route/component owns file preview state and viewer selection?
- Should file serving URLs be short-lived per click, pre-created when the agent mentions a path, or created lazily when a user opens a referenced path?
- Which deployments should enable WebSocket data fallback for file/web-serving bytes?
- Whether QUIC lands before web serving productization or can be introduced after file serving productization.
