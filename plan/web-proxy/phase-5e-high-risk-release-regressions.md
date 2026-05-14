# Phase 5e: High-Risk Release Regressions

## Context

Phase 5d locked in the core service-side WebSocket/HMR behavior, but the
progress and validation checklists still contain several high-risk gaps that
should be closed before treating the web-proxy branch as release-ready.

This phase consolidates those gaps into one focused regression pass. The goal
is not to finish every remaining web-proxy feature; it is to prove the safety
and lifecycle boundaries that could otherwise produce private-data leaks,
stuck browser sessions, daemon resource leaks, or deployment-only failures.

Related plan docs:

- `phase-2-proxy-domain-gateway-and-private-auth.md`
- `phase-5-prep-observability-and-hardening.md`
- `phase-5a-protocol-and-daemon-websocket-bridge.md`
- `phase-5b-gateway-upgrade-and-browser-bridge.md`
- `phase-5c-vite-hmr-validation-and-product-hardening.md`
- `phase-5d-websocket-regression-and-failure-states.md`
- `validation-checklist.md`

## Objective

Add release-blocking regression coverage and runbooks for the remaining risky
web-proxy behavior:

- owner-only gateway auth and viewer-cookie lifecycle
- daemon/local WebSocket echo fidelity
- browser-to-local endpoint-host WebSocket echo fidelity
- daemon-disconnect cleanup for active HTTP and WebSocket proxy work
- reset/error diagnostics without leaking secrets
- local and production WebSocket upgrade deployment assumptions

## Risk Ranking

### P0: Security And Ownership

These must be covered before release because they protect private local apps.

- owner can mint viewer grants only for owned proxied sites
- non-owner cannot mint grants, read sites, attach sites, or list another
  user's sites
- viewer grants expire quickly and are one-time use
- bootstrap request host must match the grant's endpoint host
- endpoint-host gateway resolves the site before auth and rejects
  disabled/expired sites before daemon work allocation
- missing, invalid, expired, or revoked viewer sessions reject before daemon
  work allocation
- viewer cookies are host-only, `HttpOnly`, and `Secure` when the proxy scheme
  is HTTPS
- local-app cookies cannot overwrite reserved Bud proxy cookies
- Bud app/auth cookies and viewer grant tokens never reach the daemon/local app

### P0: Lifecycle Cleanup

These must be covered because failures here can leave users staring at
infinite loading states or leave daemon/service runtime state active after the
Bud is gone.

- active browser WebSockets close on daemon disconnect
- active HTTP proxy streams reset/complete on daemon disconnect
- service runtime maps and `proxied_site.active_stream_id` are cleared after
  transport loss
- reconnect plus reload can recover without stale runtime state
- stable idle Vite HMR does not create a request/reset storm

### P0: WebSocket Echo Fidelity

These must be covered because Vite happened to work manually, but the product
contract is broader than one framework smoke test.

- daemon local WebSocket client can connect to an echo server on `localhost`
- daemon rejects unsupported WebSocket targets and revalidates `localhost` as
  loopback
- text frames round-trip browser to local server and back
- binary frames round-trip browser to local server and back
- local close code/reason propagate to browser/service
- browser close code/reason propagate to daemon/local server
- local connect failure produces a typed service-visible failure instead of an
  indefinite load

### P1: Diagnostics And Log Hygiene

These should be done in the same pass because they are the difference between a
debuggable spike and a supportable product surface.

- service reset logs include canonical error code, stream id, site id, Bud id,
  transport kind, and request path
- daemon reset logs include inbound error code and stream id
- gateway logs omit viewer grants, cookies, request bodies, response bodies,
  and WebSocket payloads
- local connect failures, connection limits, open timeouts, and transport loss
  are visible in product state where the owning app can observe them

### P1: Deployment Upgrade Checks

These are required before production rollout because local HMR can pass while a
load balancer or reverse proxy silently breaks upgrades.

- local development WebSocket upgrades work through the service entrypoint
- production edge plan supports `*.bud.show` WebSocket upgrades
- wildcard DNS/TLS and load-balancer routing assumptions are documented
- gateway preserves endpoint-host identity into Fastify
- proxy-domain auth still works through the deployed edge path

## Non-Goals

- No redirect rewriting implementation.
- No broad browser matrix beyond Chrome for this phase.
- No local HTTPS mkcert+Caddy implementation; Phase 8 owns that.
- No iOS implementation, though this phase should leave enough auth behavior
  documented for iOS validation.
- No public/password sharing.
- No gateway extraction or QUIC/HTTP/3 implementation.

## Proposed Workstreams

### 1. Gateway Auth And Cookie Regression Suite

Add focused service route/unit coverage for:

- grant minting requires an authenticated owner
- grant token cannot be consumed twice
- expired grant is rejected
- grant endpoint host mismatch is rejected
- bootstrap sets the expected viewer cookie attributes for HTTP local mode and
  HTTPS configured mode
- viewer-session refresh/update follows the configured roughly one-day window
- revoked/expired viewer sessions reject before daemon allocation
- API/thread attach routes enforce owner and Bud boundaries
- endpoint-host gateway never forwards Bud reserved cookies upstream

Preferred files:

- `service/src/routes/proxied-sites.test.ts`
- `service/src/proxy/proxied-site.test.ts`
- `service/src/proxy/proxy-edge.test.ts`

### 2. Daemon Local WebSocket Echo Tests

Add daemon-side tests around the local WebSocket client and target policy:

- local echo server on `localhost`
- local echo server on `127.0.0.1`
- local echo server on `::1` where the host supports it
- unsupported hostnames and non-loopback resolved addresses are rejected
- text, binary, close, and local error behavior map to `proxy_ws_*` frames

Preferred files depend on the current daemon module boundaries, but expected
spec updates are:

- `bud/src/src.spec.md`
- `docs/proto.md` only if frame semantics change

### 3. Browser-To-Local Gateway Echo Tests

Add an integration-style service test that exercises the full gateway path
against a local echo server with an authorized endpoint-host viewer session:

- browser upgrade enters the endpoint-host gateway
- service sends `proxy_ws_open` after auth
- daemon/local side accepts
- text and binary messages round-trip
- browser close reaches local server
- local close reaches browser
- oversized messages and open timeout close with typed errors

If a single in-process integration harness is too expensive, split this into:

- a service gateway test with a fake data-plane carrier
- a daemon/local echo test with a fake service carrier
- one manual smoke script that runs both sides together

### 4. Daemon Disconnect And Reset-Storm Tests

Add regression coverage for transport loss while proxy work is active:

- active WebSocket session closes when the Bud WebSocket/data-plane tracker
  finalizes
- active HTTP proxy stream resets when the Bud disconnects
- runtime state is removed from maps after finalization
- DB state such as `proxied_site.active_stream_id` is cleared where applicable
- repeated reload/reconnect does not reuse stale stream ids
- idle Vite HMR smoke run remains stable for at least one minute with no
  request/reset storm

Preferred files:

- `service/src/transport/data-plane-router.test.ts`
- `service/src/ws/bud-connection.test.ts`
- `service/src/proxy/proxy-ws-runtime.test.ts`
- `service/src/routes/proxied-sites.test.ts`

### 5. Diagnostics And Deployment Checks

Add targeted logging tests where practical and document the parts that are
deployment-runbook only:

- service logs include structured reset/open-failure context
- daemon logs include inbound reset/error context
- tests or assertions confirm secrets are not included in log fields
- local WebSocket upgrade runbook covers service and web dev entrypoints
- production runbook covers wildcard DNS, TLS, load balancer upgrade headers,
  and endpoint-host preservation

## Spec Files To Update

- [ ] `plan/web-proxy/web-proxy.spec.md`
- [ ] `plan/web-proxy/progress-checklist.md`
- [ ] `plan/web-proxy/validation-checklist.md`
- [ ] `service/src/proxy/proxy.spec.md`
- [ ] `service/src/routes/routes.spec.md`
- [ ] `service/src/transport/transport.spec.md`
- [ ] `service/src/ws/ws.spec.md`
- [ ] `bud/src/src.spec.md` if daemon tests or local WebSocket modules change
- [ ] `docs/proto.md` if frame semantics change

## Impacted Contracts

- [ ] WSS protocol: only if daemon close/error semantics change
- [ ] SSE events: only if product-visible failure-state events are added
- [ ] DB schema: not expected
- [ ] Agent tools: not expected unless tool result diagnostics change
- [ ] Web UI: only if new observable failure state fields are surfaced

## Acceptance Criteria

- Gateway auth/security tests cover owner, non-owner, expired, disabled,
  revoked, and host-mismatch paths.
- Daemon/local echo tests cover text, binary, close, and local connect failure.
- Browser-to-local gateway echo tests cover an authorized endpoint-host upgrade
  and at least one round trip in each direction.
- Daemon disconnect closes active WebSocket and HTTP proxy runtime state without
  stale active stream ids.
- Local Vite HMR remains stable during the manual idle smoke run.
- Reset/open-failure logs contain enough structured context to debug failures
  without exposing grants, cookies, or payload bodies.
- Deployment runbook states the concrete wildcard DNS/TLS/load-balancer
  assumptions required for `*.bud.show` WebSocket upgrades.

## Suggested Implementation Order

1. Gateway auth/security tests.
2. Daemon/local WebSocket echo tests.
3. Browser-to-local gateway echo tests.
4. Daemon-disconnect cleanup regressions.
5. Reset/log hygiene assertions and runbook updates.
6. Local/prod WebSocket upgrade deployment checklist.

## Rollout Notes

This phase should be completed before a production `bud.show` rollout. It does
not need to block continued local dogfooding if the known gaps remain tracked
and the feature remains owner-private.
