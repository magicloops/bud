# Phase 9f: WebSocket Upgrade Deployment Checks

## Context

Local Vite HMR can pass while production fails if DNS, TLS, load balancers, or
reverse proxies mishandle wildcard endpoint hosts or WebSocket upgrade headers.
This phase documents and validates the deployment assumptions needed for
`*.bud.show`.

Related docs:

- `phase-5c-vite-hmr-validation-and-product-hardening.md`
- `phase-8-local-https-dev.md`
- `phase-7-sharing-gateway-extraction-and-transport.md`

## Objective

Provide a concrete local and production WebSocket upgrade checklist so the
proxy can be rolled out without edge-only surprises.

## Scope

- Local service entrypoint WebSocket upgrade check.
- Wildcard endpoint-host DNS/TLS assumptions.
- Load balancer/reverse proxy upgrade handling.
- Host header preservation into Fastify.
- Proxy-domain auth through deployed edge path.
- Production smoke/runbook documentation.

## Non-Goals

- No mkcert+Caddy implementation; Phase 8 owns local HTTPS.
- No gateway extraction implementation.
- No public/password sharing.
- No rate-limit/quota implementation beyond documenting release expectations.

## Design / Approach

Document and validate:

- wildcard DNS exists for `*.bud.show`
- wildcard TLS certificate automation exists
- load balancer routes `*.bud.show` to the gateway handler
- `Connection: Upgrade` and `Upgrade: websocket` are preserved
- `Sec-WebSocket-Protocol` is preserved
- endpoint host is preserved into Fastify host matching
- app/API origin and proxy origin remain isolated
- viewer bootstrap and cookie auth work through the deployed edge
- HMR WebSocket connects through the deployed edge
- production logs omit cookies, grants, bodies, and WebSocket payloads

For local development, document:

- HTTP-only local path for `*.proxy.localhost`
- optional HTTPS path from Phase 8 when needed
- what developers should check when a browser blocks embedded cookies

## Spec Files To Update

- [ ] `plan/web-proxy/progress-checklist.md`
- [ ] `plan/web-proxy/validation-checklist.md`
- [ ] root `README.md` or getting-started docs when deployment/local docs are
  added
- [ ] package READMEs if local commands change
- [ ] deployment docs when the production edge path is finalized

## Impacted Contracts

- [ ] WSS protocol: no
- [ ] SSE events: no
- [ ] DB schema: no
- [ ] Agent tools: no
- [ ] Web UI: no

## Test Plan

Manual production-like smoke:

1. Open a private proxied site through the deployed proxy endpoint host.
2. Confirm root HTML and root-absolute assets load.
3. Confirm HMR/app WebSocket upgrade succeeds.
4. Confirm viewer bootstrap/cookie auth works after a clean browser session.
5. Confirm the same endpoint host works in standalone tab.
6. Confirm embedded web view shows fallback if cookies are blocked.
7. Confirm service logs contain no grants, cookies, bodies, or WebSocket
   payloads.

Local smoke should be documented separately for HTTP-only and optional HTTPS
profiles.

## Acceptance Criteria

- The concrete DNS/TLS/load-balancer requirements are documented.
- WebSocket upgrade behavior is validated through the intended deployment path.
- Endpoint-host preservation into Fastify is validated.
- Proxy-domain auth works through the edge path.
- The release checklist states any remaining production-only risks clearly.
