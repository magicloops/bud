# Design: Network Upgrade Web Serving Productization

## Context

The network-upgrade PR includes localhost proxy foundations that are acceptable to merge as infrastructure. The open-source baseline is binary `BudEnvelope` stream frames on the authenticated daemon WebSocket; HTTP/2 gRPC data remains optional and QUIC remains a later performance carrier.

- `proxy_session` schema and ownership helpers
- proxy route contracts
- service proxy edge for strict loopback `GET` / `HEAD` over the selected data-plane carrier
- daemon localhost proxy adapter
- typed `proxy_open` / `proxy_open_result` payloads
- durable operation/stream state
- per-Bud stream concurrency, service-side response byte limits, chunk/credit caps, idle timeout, and stream TTL
- real-daemon proxy smoke over WebSocket with gRPC disabled

Those pieces are not the shipped web-serving product. Productization is deferred to this follow-on design.

## Goal

Let a user view a locally running web server on a Bud host through a service-owned URL.

The product should support common development-server use cases first:

- agent or user identifies a local port
- service creates a short-lived proxy session for the authorized Bud/thread/port
- browser opens a service URL
- service proxies allowed HTTP traffic through the daemon using the shared stream model

## Non-Goals

- raw TCP proxying
- LAN proxying
- public permanent shares
- arbitrary hostnames
- Docker, Kubernetes, SSH agent, Unix socket, metadata-service, or `file://` proxying
- browser direct-to-daemon networking
- request-body heavy workflows before explicit policy and limits

## Current Foundation To Keep

The already-added proxy DB routes and daemon/service adapter work can remain in the network-upgrade PR as foundation and validation evidence.

Before exposing the feature as web serving, the follow-on PR must still harden:

- unauthenticated and non-owner route behavior
- user-visible session lifecycle
- proxy policy beyond loopback `GET` / `HEAD`
- redirects
- local SSE
- request bodies
- asset concurrency
- optional WebSocket upgrades
- transport selector behavior

## Product Contract

Initial UX options:

- agent mentions a local server URL or port and the UI offers `Open web server`
- user opens a port from a Bud/thread action menu
- service returns a short-lived proxy URL with status metadata

The browser should not know whether bytes flowed over WebSocket, HTTP/2, or future QUIC. It only sees service-owned HTTPS routes.

Proxy sessions should be created from an explicit user action for the first product version: a detected localhost URL/port action, or a Bud/thread menu action. Auto-creating proxy sessions from every mentioned port would create surprising network reachability and noisy audit records.

## Service Design

Existing lower-level contract:

- `POST /api/buds/:budId/proxy-sessions`
- `GET /api/proxy/:proxySessionId/*`
- `HEAD /api/proxy/:proxySessionId/*`
- WebSocket-first stream transport through carrier-neutral `DataPlane*` selectors

Service requirements for productization:

- authorize viewer before creating or opening a proxy session
- validate thread ownership when thread context is supplied
- filter proxy-session lookups by owner in SQL
- return `401` for unauthenticated browser requests
- return `404` for signed-in non-owners
- reject expired/revoked sessions before daemon work
- sanitize request and response headers
- strip Bud auth cookies and hop-by-hop headers
- enforce method, body, response, stream, and duration limits
- audit session create/revoke/open/deny/reset/close/expire outcomes

## Daemon Policy

Initial daemon proxy policy should remain strict:

- only `http://127.0.0.1:<explicit_port>`
- no DNS resolution for user-controlled hosts
- redirects disabled or revalidated before following
- `GET` and `HEAD` first
- request bodies only after explicit capability and limits
- deny LAN, metadata, wildcard, Unix socket, Docker, Kubernetes, SSH agent, and `file://` targets
- enforce connection and read timeouts
- enforce max response bytes per stream/session

## Transport

Web serving should use the same stream selector as file serving:

```text
WebSocket control+data baseline
  -> optional HTTP/2 BudData.Attach when configured and healthy
  -> future QUIC data stream when implemented and healthy
```

The API should be transport-independent from day one. QUIC should improve asset concurrency and head-of-line behavior, not change the route contract.

## Protocol Payload Debt

The network-upgrade foundation keeps the current proxy stream semantics transport-independent, but the proxy stream family may still carry transitional whole-frame `frame_json` in `proxy_open`, `proxy_open_result`, and shared generic stream payloads. That is acceptable for the foundation PR because the product is not exposed yet.

Web-serving productization should remove that debt for proxy traffic:

- add direct protobuf fields for proxy open/result payloads where missing
- keep byte movement on shared generic stream frames rather than inventing proxy-only byte frames
- update service and daemon codecs together
- add conformance tests proving proxy payloads use typed fields rather than whole-frame `frame_json`
- ensure optional HTTP/2 and future QUIC adapters carry the same payload fields without a proxy-specific fork

## Remaining Foundation Follow-Ups

These items were intentionally left as future web-serving productization work rather than merge blockers for the WebSocket-first transport foundation.

- [ ] Add route-level proxy-edge tests for selected-carrier send refusal and thrown send failures, proving deterministic `424` responses and no dangling `bud_operation`, `bud_stream`, or `proxy_session.active_stream_id` state.
- [ ] Add route-level proxy-edge tests for accepted `proxy_open_result` frames without required HTTP status metadata, proving protocol reset, cleanup, audit, and deterministic `502`.
- [ ] Add route-level proxy-edge tests for open timeout and daemon open rejection, including durable operation/stream terminal states.
- [ ] Add concurrent file/proxy stream-id uniqueness coverage so two simultaneous sessions cannot collide or cross-deliver bytes.
- [ ] Add monotonic `stream_data` sequence/offset validation coverage for concurrent proxy streams.
- [ ] Add real-daemon negative proxy smokes for non-loopback targets, unsupported methods, unsupported schemes, response byte limits, and daemon policy denials.
- [ ] Add typed denial propagation checks proving daemon proxy denials reach the browser/service as structured errors and audit events.

## Validation

Required before product exposure:

- owner and non-owner route tests
- unauthenticated route tests
- WebSocket-only proxy smoke with gRPC disabled
- service limit tests for concurrency, response byte ceiling, chunk/credit, idle, and TTL paths
- daemon target-policy denial tests
- real-daemon negative smokes for non-loopback targets, LAN/metadata/wildcard hosts, redirects to unsafe targets if redirects are supported, and unsupported schemes
- real-daemon negative smokes for unsupported proxy methods and request bodies while those remain disabled
- real-daemon negative smokes for response byte limits and session/stream TTL limits
- typed denial propagation tests proving daemon proxy denials reach the service/browser as structured errors and audit events, without leaking unnecessary host details
- local HTTP server smoke through the production proxy edge
- streaming response tests
- redirect handling tests
- header allowlist tests
- local SSE validation if supported
- request body validation if supported
- optional WebSocket upgrade validation if supported
- degraded/offline/expired/denied UI states

## Exit Criteria

- users can open a local loopback development server through Bud
- proxy sessions are short-lived, revocable, audited, and owner-scoped
- daemon policy prevents unsafe local/network targets
- transport selection is internal and observable
- web serving has a separate acceptance gate from file serving
