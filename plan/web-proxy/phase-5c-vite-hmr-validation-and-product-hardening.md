# Phase 5c: Vite HMR Validation

## Objective

Validate the generic WebSocket bridge against real local-development dev-server
behavior. Vite HMR is the primary acceptance target; Next.js HMR is a follow-up
target unless the team explicitly expands scope.

This phase has now proven the core Vite path manually. Product failure states
and regression coverage are tracked in
[Phase 5d](./phase-5d-websocket-regression-and-failure-states.md).

## Scope

- Validate Vite dev server through the proxy endpoint host.
- Tune Host/Origin/subprotocol behavior for Vite compatibility.
- Add production-edge and local-dev deployment checks for WebSocket upgrades.
- Capture the manual Vite HMR validation result and promote repeatable smoke
  steps into Phase 5d.

## Non-Goals

- No broad framework guarantee beyond Vite.
- No public/password sharing.
- No QUIC/HTTP/3 transport work.
- No full local HTTPS implementation unless Phase 8 is being run in parallel.

## Vite Acceptance Target

Status as of May 13, 2026: manually validated. Editing a file in the proxied
Vite app showed a live page update through the proxy.

Validation app:

1. Run a Vite dev server on the daemon host.
2. Create a proxied site for the Vite port.
3. Open the endpoint host in Chrome.
4. Confirm initial HTML loads.
5. Confirm `/@vite/client` loads from the endpoint host.
6. Confirm module assets load from the endpoint host.
7. Confirm the HMR WebSocket connects through the endpoint host.
8. Edit a component and confirm the page updates without manual reload.
9. Confirm no daemon/service reset storm appears during idle HMR operation.

## Product Hardening Follow-Up

Now that Vite HMR works, hardening should move to
[Phase 5d](./phase-5d-websocket-regression-and-failure-states.md). That phase
covers echo regression tests, active socket cleanup on disable/expiry/daemon
disconnect, user-visible failure states, and agent/tool messaging.

## Deployment Checks

Local HTTP:

- standalone top-level `proxy.localhost` WebSocket works where browser policy
  allows `ws://`.
- embedded iframe behavior still depends on cookie policy from earlier phases.

Local HTTPS Phase 8 profile:

- `wss://<slug>.proxy.bud.localhost` upgrades through Caddy.
- `Host` is preserved to Fastify for proxy endpoint hosts.
- app/API/SSE/Bud daemon WebSocket still work through Caddy.

Production:

- wildcard DNS and TLS support `*.bud.show`
- load balancer permits WebSocket upgrades
- idle timeouts are longer than expected HMR idle periods
- gateway logs omit cookies, grants, and WebSocket payloads

## Tests

Add tests for:

- repeatable Vite HMR smoke in supported local/dev environment
- HMR socket path and query are preserved
- module updates do not require full page reload
- no request/reset storm occurs during stable idle Vite dev session

Product-state and lifecycle regression tests are Phase 5d.

## Spec Files To Update During Implementation

- `web/src/features/threads/threads.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/proxy/proxy.spec.md`
- `service/src/routes/routes.spec.md`
- `plan/web-proxy/phase-5d-websocket-regression-and-failure-states.md`
- `docs/proto.md`

## Acceptance Criteria

- Vite HMR works through private owner-only proxied sites in Chrome.
- Component edits update without manual reload.
- The validated Vite scenario does not produce uncontrolled request or reset
  loops.
- Phase 5d contains the remaining hardening and product-state checklist.
