# Phase 5c: Vite HMR Validation And Product Hardening

## Objective

Validate and harden the generic WebSocket bridge against real local-development
dev-server behavior. Vite HMR is the primary acceptance target; Next.js HMR is
a follow-up target unless the team explicitly expands scope.

## Scope

- Validate Vite dev server through the proxy endpoint host.
- Tune Host/Origin/subprotocol behavior for Vite compatibility.
- Make unsupported or failed WebSocket states visible in UI/tool output.
- Add production-edge and local-dev deployment checks for WebSocket upgrades.
- Add regression coverage and a manual smoke runbook.

## Non-Goals

- No broad framework guarantee beyond Vite.
- No public/password sharing.
- No QUIC/HTTP/3 transport work.
- No full local HTTPS implementation unless Phase 8 is being run in parallel.

## Vite Acceptance Target

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

## Product Hardening

User-visible states:

- Bud offline
- WebSocket proxy unsupported by daemon
- WebSocket open rejected by local target
- WebSocket closed due to site disable/expiry
- WebSocket connection limit exceeded
- HMR not available in current environment

Agent/tool behavior:

- `web_view.open` result should report `websocket: true` only when the selected
  Bud transport and daemon capability support WebSocket proxying.
- If WebSocket proxying is unavailable, the assistant should say that static
  HTTP preview may still work but Vite HMR will not.
- Tool results must not include viewer grants, cookies, or raw daemon stream
  ids.

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

- Vite HMR smoke in supported local/dev environment
- HMR socket path and query are preserved
- module updates do not require full page reload
- failed local WebSocket target produces product-safe close/error
- connection limits surface useful errors
- active sockets close on site disable, expiry, and daemon disconnect
- no request/reset storm occurs during stable idle Vite dev session

## Spec Files To Update During Implementation

- `web/src/features/threads/threads.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/proxy/proxy.spec.md`
- `service/src/routes/routes.spec.md`
- `docs/proto.md`

## Acceptance Criteria

- Vite HMR works through private owner-only proxied sites in Chrome.
- Component edits update without manual reload.
- The web UI and agent tool results accurately report WebSocket capability.
- Production/local deployment docs include WebSocket upgrade requirements.
- The validated Vite scenario does not produce uncontrolled request or reset
  loops.
