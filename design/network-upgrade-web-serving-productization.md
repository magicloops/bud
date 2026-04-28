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

## Validation

Required before product exposure:

- owner and non-owner route tests
- unauthenticated route tests
- WebSocket-only proxy smoke with gRPC disabled
- service limit tests for concurrency, response byte ceiling, chunk/credit, idle, and TTL paths
- daemon target-policy denial tests
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
