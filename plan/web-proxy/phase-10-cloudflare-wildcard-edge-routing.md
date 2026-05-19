# Phase 10: Cloudflare Wildcard Edge Routing

## Context

The first staging rollout for hosted web views should route `*.bud.show`
through Cloudflare before forwarding to the existing Render `bud-service`
origin. This gives us a production-like edge layer for wildcard DNS, TLS,
WebSocket upgrades, cache bypass rules, and future gateway policy without
making Render terminate the wildcard domain directly.

The current deployment runbook covers path-routed app/API traffic on
`staging.bud.dev`. `*.bud.show` is different: every path belongs to the proxy
gateway, and the service must resolve the external endpoint host from the
edge-forwarded request. The current service gateway uses the raw `Host` header
for host matching, which is correct for direct/local routing but will not work
when a Worker rewrites the upstream URL to `bud-service.onrender.com`.

Related docs:

- `phase-9f-websocket-upgrade-deployment-checks.md`
- `design/web-serving-preview-domain-architecture.md`
- `plan/deploy/cloudflare-front-door-runbook.md`

## Objective

Make `*.bud.show` usable through Cloudflare Worker -> Render service routing
without requiring Render to own the wildcard custom domain.

## Scope

- Resolve proxy gateway endpoint hosts from trusted forwarded-host headers when
  requests arrive through the configured edge path.
- Preserve direct/local gateway behavior that uses raw `Host`.
- Cover both HTTP and WebSocket proxy gateway routing.
- Add an edge trust guard so direct requests to the Render origin cannot spoof
  `*.bud.show` with arbitrary forwarded headers.
- Document the Worker route shape, Render env, Cloudflare env, and validation
  sequence.

## Non-Goals

- No Render wildcard custom-domain setup for this first shape.
- No standalone gateway service extraction.
- No public/password sharing.
- No Cloudflare Tunnel or daemon-host ingress.
- No rate-limit/quota policy implementation beyond rollout notes.

## Design / Approach

### Service Gateway Host Resolution

Add a shared helper for proxy-gateway host resolution. The helper should:

- prefer direct `Host` when it already matches `*.${PROXY_BASE_DOMAIN}`
- otherwise use `x-forwarded-host` only when the request is trusted as coming
  through the Cloudflare edge path
- normalize ports and casing the same way as current `normalizeHostHeader`
- reject forwarded hosts outside `PROXY_BASE_DOMAIN`
- return `null` rather than silently routing ambiguous requests

Use the helper in:

- HTTP gateway route matching and endpoint-host lookup
- WebSocket gateway handshake/subprotocol selection
- WebSocket gateway authorization and endpoint-host lookup

### Edge Trust Guard

Do not trust `x-forwarded-host` from arbitrary direct requests to the Render
origin. Add a lightweight shared-secret guard:

- Render env: `PROXY_EDGE_SECRET`
- Worker secret: `PROXY_EDGE_SECRET`
- Worker request header: `x-bud-edge-secret`

The service should honor `x-forwarded-host` for proxy-gateway routing only when
`x-bud-edge-secret` matches the configured secret. If no edge secret is
configured, forwarded-host gateway routing should stay disabled in production
and tests should make that behavior explicit.

The existing non-secret `x-bud-edge-router: cloudflare-worker` header can remain
useful for diagnostics but should not be treated as an authorization signal.

### Cloudflare Worker Route

Extend the current Worker shape with a host-based branch for `*.bud.show`.
This branch should:

- match all paths for wildcard proxy hosts
- rewrite the upstream URL to the Render service origin
- preserve the incoming host in `x-forwarded-host`
- set `x-forwarded-proto=https`
- set `x-forwarded-port=443`
- set `x-bud-edge-router=cloudflare-worker`
- set `x-bud-edge-secret` from the Worker secret binding
- preserve method, body, query string, and WebSocket upgrade behavior
- use `cache: "no-store"` and avoid CDN caching

The existing path-gated `staging.bud.dev` branch can remain for app/API/auth
traffic. It should not be reused unchanged for `*.bud.show`, because proxied
sites need normal app paths and assets such as `/`, `/src/main.tsx`, and
`/@vite/client`.

### Render Configuration

Set or verify on `bud-service`:

```text
APP_BASE_URL=https://staging.bud.dev
BETTER_AUTH_URL=https://staging.bud.dev
API_AUDIENCE=https://staging.bud.dev/api
BETTER_AUTH_TRUSTED_ORIGINS=https://staging.bud.dev
PROXY_PUBLIC_SCHEME=https
PROXY_BASE_DOMAIN=bud.show
PROXY_PUBLIC_PORT=
PROXY_GATEWAY_ENABLED=true
PROXY_VIEWER_COOKIE_NAME=__Host-bud_proxy_viewer
PROXY_EDGE_SECRET=<shared secret also configured in Cloudflare>
```

Do not add `bud.show` to normal Better Auth trusted origins. Bud app auth,
OAuth, API, and daemon WebSocket traffic continue to use `staging.bud.dev`.

## Spec Files To Update

- [x] `service/src/src.spec.md`
- [x] `service/src/routes/routes.spec.md`
- [x] `service/src/proxy/proxy.spec.md`
- [x] `plan/web-proxy/progress-checklist.md`
- [x] `plan/web-proxy/validation-checklist.md`
- [x] `plan/deploy/cloudflare-front-door-runbook.md`

## Impacted Contracts

- [ ] WSS protocol: no
- [ ] SSE events: no
- [ ] DB schema: no
- [ ] Agent tools: no
- [ ] Web UI: no
- [x] Deployment/edge contract: yes

## Test Plan

Service tests:

1. Direct `Host: <slug>.bud.show` continues to route through the proxy gateway.
2. Direct `Host: <slug>.bud-show.test:3443` continues to route locally.
3. `Host: bud-service.onrender.com` plus trusted `x-forwarded-host:
   <slug>.bud.show` routes through the proxy gateway.
4. The same forwarded-host request without the edge secret does not route.
5. A forwarded host outside `PROXY_BASE_DOMAIN` does not route.
6. HTTP bootstrap, HTTP proxy, and WebSocket proxy paths all use the same
   resolved endpoint host.
7. Direct Render-origin spoof attempts cannot consume viewer grants or allocate
   daemon proxy work without the edge secret.

Deployment smoke:

1. Confirm Cloudflare has proxied wildcard DNS for `*.bud.show`.
2. Confirm Cloudflare has a Worker route for `*.bud.show/*`.
3. Open a generated bootstrap URL:
   `https://<slug>.bud.show/__bud/bootstrap?grant=...&to=%2F`.
4. Confirm the clean redirected endpoint URL loads root HTML and root-absolute
   assets.
5. Confirm `wss://<slug>.bud.show/...` upgrades through Cloudflare and Render.
6. Confirm direct requests to the Render origin with spoofed forwarded headers
   fail.
7. Confirm logs omit grants, cookies, request bodies, response bodies, and
   WebSocket payloads.

## Rollout

1. Deploy service changes with `PROXY_EDGE_SECRET` configured in Render.
2. Add the matching Worker secret in Cloudflare.
3. Add the `*.bud.show/*` Worker route and proxied wildcard DNS.
4. Validate a generated proxied site through `https://<slug>.bud.show`.
5. Validate WebSocket/HMR through `wss://<slug>.bud.show`.
6. If validation fails, remove or disable the `*.bud.show/*` Worker route; the
   existing `staging.bud.dev` app/API path remains independent.

## Staging Validation Result

Validated on 2026-05-18 after merging the branch with `main` and deploying to
staging:

- Render `bud-service` and the Cloudflare Worker had matching
  `PROXY_EDGE_SECRET` values.
- Cloudflare `bud.show` had proxied wildcard DNS, the `*.bud.show/*` Worker
  route, cache bypass, transform bypass, WebSockets enabled, and URL
  normalization disabled.
- `dig` and `curl` confirmed `*.bud.show` resolves and reaches Cloudflare.
- Generated `https://<slug>.bud.show` web-view URLs loaded correctly through
  the staging web client.
- Generated `https://<slug>.bud.show` web-view URLs loaded correctly through
  the staging mobile client.

## Acceptance Criteria

- `*.bud.show` routes through Cloudflare Worker to Render `bud-service`.
- The service resolves the endpoint host correctly for both direct/local and
  trusted edge-forwarded requests.
- The service does not trust spoofed forwarded-host headers from direct Render
  origin requests.
- HTTP, bootstrap, and WebSocket proxy paths all work through the deployed
  wildcard edge route.
- Deployment runbook and validation checklist describe the exact edge contract.
