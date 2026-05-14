# Design: Web Proxy Follow-On Hardening

## Context

The web proxy is now useful enough for the main local-dev workflow:

- users can create durable Bud-scoped proxied sites
- private owner access is enforced through endpoint-host viewer cookies
- static HTTP proxying works through the daemon data plane
- small HTTP responses now preserve data/close ordering on first load through
  per-stream data-plane serialization
- Vite HMR WebSockets work through the proxy endpoint host
- the web UI can distinguish static HTTP transport from WebSocket/HMR support
- active WebSockets close when a site is disabled or expires

This unblocks local development previews, but it is not yet a release-hardened
proxy surface. The remaining work is mostly coverage, diagnostics, failure
presentation, and deployment readiness rather than a change in architecture.

This document tracks the follow-on hardening that should happen before broader
rollout.

## Current Position

The chosen architecture remains:

```text
browser / mobile client
  -> isolated proxy endpoint host
  -> Bud service gateway
  -> selected daemon data-plane carrier
  -> loopback HTTP/WebSocket target on the Bud host
```

Durable proxied sites are Bud-owned resources. Thread web views are attachments
to those sites, not the security or lifecycle root.

The service process is still the logical proxy gateway. That is the right
implementation point for now because it already owns daemon connection state.
Extraction into a dedicated gateway should wait for traffic, scaling, or
security-review pressure.

## Goals

- Preserve the currently working Vite HMR path.
- Prove WebSocket behavior with automated text, binary, close, error, and
  reconnect/loss coverage.
- Make every common failure mode visible in the Bud product surface instead of
  leaving users with an indefinite loading pane or raw JSON error.
- Ensure unauthorized or invalid proxy traffic never allocates daemon work.
- Keep proxy logs and tool payloads free of cookies, grants, request bodies,
  response bodies, and WebSocket payloads.
- Make production and local deployment assumptions explicit before broad use.

## Non-Goals

- No public sharing or password access policy in this hardening pass.
- No arbitrary LAN targets or non-loopback hostnames.
- No local HTTPS implementation; that remains the mkcert/Caddy phase.
- No request-body, mutation-method, redirect-rewrite, or local-app cookie
  fidelity; those remain the HTTP fidelity phase.
- No standalone gateway extraction unless scaling or security review requires
  it.

## Remaining Hardening Areas

### 1. Automated WebSocket Regression Coverage

Coverage should move from "manual Vite works" to layered automated tests.

Service runtime tests should cover:

- browser text frame to daemon `proxy_ws_message`
- browser binary frame to daemon `proxy_ws_message`
- daemon text frame to browser socket
- daemon binary frame to browser socket
- daemon close propagation to browser
- browser close propagation to daemon
- daemon error propagation to browser
- oversized browser and daemon frames
- open timeout and idle timeout
- active-session cleanup helpers

Daemon/local adapter tests should cover:

- unsupported target hosts are rejected
- `localhost` resolves only to loopback addresses before dialing
- text echo round-trips through a local WebSocket server
- binary echo round-trips through a local WebSocket server
- local close propagates back to service/browser
- service/browser close closes the local socket
- local connect failure returns a typed `proxy_ws_open_result` error
- reserved Bud/proxy credentials are not forwarded to the local target

Gateway tests should cover:

- unauthenticated upgrade rejects before daemon operation/stream allocation
- invalid viewer cookie rejects before daemon operation/stream allocation
- disabled and expired sites reject before daemon work
- authorized endpoint-host upgrade reaches the daemon runtime
- pending browser messages before daemon open are bounded
- pending messages flush after daemon open succeeds
- per-site connection limit is enforced
- per-Bud connection limit is enforced

Recommended order:

1. Keep fast unit tests for the in-memory runtime.
2. Add service-level tests with a fake daemon data-plane tracker.
3. Add one full daemon integration test against a local echo WebSocket server.
4. Keep the manual Vite HMR smoke runbook for framework-level confidence.

### 2. Lifecycle Cleanup

The important cleanup invariant is:

```text
if the site, viewer, daemon carrier, or browser goes away,
both sides of the proxied WebSocket should close promptly
and durable operation/stream state should enter a terminal state.
```

Already covered:

- per-stream data-plane lifecycle frames are serialized, preventing
  `stream_close.final_offset` races for small responses
- site disable closes active service runtime sessions
- site expiry closes active service runtime sessions
- browser close sends a daemon close frame and cleans service runtime state
- transport finalization resets registered runtime streams

Remaining coverage:

- explicit daemon-disconnect regression test
- superseded Bud session cleanup test
- service shutdown/drain behavior for active proxied WebSockets
- operation state correctness after post-open failures (`failed`, not
  `rejected`)
- idempotent cleanup when close/reset/error paths race

### 3. Product-Visible Failure States

The web pane now has first-pass banners for offline, disabled/expired, and
WebSocket/HMR unavailable states. The next pass should close the remaining
gaps.

Failure states to present:

- **Local connect failed**: daemon could not dial the local target.
- **Proxy auth blocked**: embedded iframe viewer cookie missing/blocked.
- **Connection limit exceeded**: per-site or per-Bud limit rejected the socket.
- **Transport lost**: daemon disconnected while the proxied site was open.
- **Open timeout**: daemon did not complete the local WebSocket open in time.

Implementation options:

- Add a lightweight proxied-site health snapshot to API responses, for example
  `last_proxy_error`, `last_websocket_error`, and `last_error_at`.
- Emit thread/Bud SSE events when a proxied site changes operational state.
- Render first-party HTML error pages on the proxy endpoint host for HTTP
  navigation failures instead of JSON bodies.
- For WebSocket failures that happen inside a loaded local app, record typed
  audit/diagnostic events and surface them in the owning Bud app on refresh or
  via SSE.

Recommendation:

- Add typed last-error snapshots for owner-visible diagnostics.
- Add proxy endpoint-host HTML error pages for top-level/iframe navigation.
- Use SSE only for owner-app state updates; do not couple local app WebSocket
  behavior to parent-window messaging yet.

### 4. Observability And Audit

We need enough signal to debug proxy issues without logging sensitive data.

Log/audit fields should include:

- `bud_id`
- `proxied_site_id`
- `endpoint_host`
- `stream_id` / `operation_id`
- transport kind and device/transport session ids
- target host and port
- request path only where safe and useful
- canonical error code
- close code and sanitized close reason

Logs must not include:

- viewer grants
- cookies
- request bodies
- response bodies
- WebSocket payloads
- authorization headers

Metrics should eventually track:

- active proxied HTTP streams
- active proxied WebSockets
- bytes proxied by direction
- open latency
- connection duration
- auth failures
- local connect failures
- transport lost events
- connection-limit rejections

### 5. Security And Abuse Guardrails

Private owner access is the current default, but the proxy endpoint host is a
browser-exposed surface and needs explicit guardrails.

Keep these invariants:

- endpoint-host auth happens before daemon work allocation
- signed-in non-owners cannot mint viewer grants
- viewer cookies are host-only and reserved
- Bud app cookies are never sent to local targets
- local targets remain loopback-only
- local target `Set-Cookie` cannot overwrite Bud proxy reserved cookies
- WebSocket subprotocols are sanitized
- close reasons and error messages are bounded before sending to browsers

Follow-on review items:

- Rate limits for viewer grant minting and proxy endpoint auth failures.
- Per-owner/per-Bud quotas for active proxied sites and active sockets.
- Abuse review before password/public access modes.
- Clear user-facing copy for what "private to owner" means.

### 6. Deployment Readiness

Before production rollout, validate:

- wildcard DNS for the proxy domain
- wildcard TLS certificate automation
- load balancer preserves `Host` for endpoint-host routing
- load balancer supports WebSocket upgrades
- proxy WebSocket idle timeout exceeds common HMR heartbeat intervals
- service/app auth domain and proxy content domain remain isolated
- Better Auth trusted origins/callbacks are compatible with the chosen domains
- local development has a documented HTTP path and a later HTTPS path

If/when the gateway is extracted, the design must answer:

- how daemon connection ownership is routed to the right gateway instance
- whether gateway traffic is sticky by Bud/device/session
- where operation/stream durable state is written
- how gateway instances share active proxied-site/session metadata
- how service-side agent tools create sites without direct gateway coupling

## Proposed Follow-On Phases

### Phase H1: Regression Coverage

Add the missing fast and integration tests:

- service fake-daemon authorized gateway echo tests
- daemon/local echo tests
- daemon disconnect and superseded-session cleanup tests
- per-site/per-Bud limit tests
- pending-before-open flush/backpressure tests

Acceptance:

- tests prove auth-before-daemon-work and text/binary/close/error behavior
- Vite HMR manual smoke remains green

### Phase H2: Diagnostics And Failure UI

Add owner-visible failure state plumbing:

- typed last-error fields or equivalent operational status in proxied-site
  responses
- endpoint-host HTML error pages for navigation failures
- web pane copy for local connect failure, auth blocked, connection limit,
  open timeout, and transport lost
- audit/log events for the same states

Acceptance:

- common failures are debuggable from the Bud UI without browser devtools
- logs remain payload/cookie/grant safe

### Phase H3: Deployment Checklist

Document and validate production/local deployment assumptions:

- wildcard DNS/TLS
- load balancer WebSocket upgrade behavior
- idle timeout policy
- local HTTP and later HTTPS setup
- operational metrics needed before broad rollout

Acceptance:

- a new team developer can run the current local stack
- production rollout has a concrete networking checklist

### Phase H4: Security Review Before Sharing

Before password/public sharing:

- review access policy model
- add rate limits and quotas
- add reserved-cookie filtering tests
- review HTML error pages for information leakage
- review slug/user-controlled host implications

Acceptance:

- private-owner mode remains safe
- sharing work has explicit prerequisites instead of hidden assumptions

## Open Questions

- Should proxied-site last-error state be persisted on the `proxied_site` row,
  stored as separate diagnostic events, or only exposed through recent audit
  events?
- Should endpoint-host failures return first-party HTML pages for all browser
  `Accept: text/html` requests, while API-like requests continue to receive
  JSON?
- What is the minimum mobile surface for proxied-site failures before iOS
  support is considered complete?
- Do we need explicit owner notification when a long-lived bookmarked proxied
  site receives repeated unauthorized traffic?
- What quotas should ship before any public/password sharing mode exists?

## References

- [Web Serving Proxied-Domain Architecture](./web-serving-preview-domain-architecture.md)
- [Phase 5d: WebSocket Regression And Failure States](../plan/web-proxy/phase-5d-websocket-regression-and-failure-states.md)
- [Web Proxy Progress Checklist](../plan/web-proxy/progress-checklist.md)
- [Web Proxy Validation Checklist](../plan/web-proxy/validation-checklist.md)
