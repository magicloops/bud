# Web Proxy Plan Spec

## Purpose

This folder contains the phased implementation plan for durable Bud web
proxying. The plan turns the web serving design documents into executable
workstreams that let authenticated Bud owners view local web servers running on
the daemon host through a dedicated `bud.show` proxy origin.

The plan treats proxied web views as long-lived Bud-owned resources, not as
short-lived thread previews. Threads can attach to a proxied site, but the site
itself can be reused across threads and bookmarked while the owning Bud remains
active.

## Files

- `implementation-spec.md`: End-to-end implementation overview, fixed
  product/security decisions, target architecture, product contracts, data
  model, rollout sequence, and risks.
- `phase-1-proxied-site-resource-and-product-routes.md`: Service database,
  ownership, durable proxied-site lifecycle, thread attachment, slugging, and
  TTL renewal plan.
- `phase-2-proxy-domain-gateway-and-private-auth.md`: Co-located `bud.show`
  gateway, host-routed HTTP proxying, owner-only viewer bootstrap, cookie-backed
  auth, and local/prod routing plan.
- `phase-3-web-and-mobile-client-surfaces.md`: Web workbench pane, site picker,
  iframe/standalone fallback behavior, SSE-driven state, and iOS client
  integration contract.
- `phase-4-http-fidelity-request-bodies-and-cookies.md`: Request-body support,
  methods, header policy, local-app cookies, redirects, response streaming, and
  daemon proxy protocol extensions.
- `phase-4a-http-methods-bodies-and-cancellation.md`: Implemented Phase 4
  subset for expanded HTTP methods, bounded request bodies over same-stream
  data frames, and browser-disconnect cancellation.
- `phase-4b-local-app-cookies.md`: Implemented Phase 4 cookie subset for
  endpoint-host local-app request cookies, out-of-band daemon `set_cookies`,
  service-side `Set-Cookie` filtering, and reserved gateway cookie protection.
- `phase-5-websocket-hmr.md`: Browser WebSocket upgrades, daemon local
  WebSocket bridging, Vite HMR acceptance target, limits, and shutdown behavior
  overview.
- `phase-5-prep-observability-and-hardening.md`: Observability, reset
  diagnostics, auth-before-daemon-work tests, and explicit unsupported-HMR
  capability surfacing before adding WebSocket support.
- `phase-5a-protocol-and-daemon-websocket-bridge.md`: Bud-service WebSocket
  proxy protocol, daemon local loopback WebSocket adapter, and daemon/service
  echo validation.
- `phase-5b-gateway-upgrade-and-browser-bridge.md`: Proxy endpoint-host
  WebSocket upgrade authorization, browser-to-daemon bridging, limits, and
  lifecycle cleanup.
- `phase-5c-vite-hmr-validation-and-product-hardening.md`: Vite HMR
  validation and WebSocket upgrade deployment checks.
- `phase-5d-websocket-regression-and-failure-states.md`: WebSocket echo
  regression coverage, lifecycle cleanup, manual HMR smoke runbook, and
  product-visible proxy/WebSocket failure states after the core Vite path has
  been validated.
- `phase-6-agent-tools-and-generated-ui.md`: Product-level `web_view` tools,
  assistant prompting, message/web-view integration, and future generated UI
  affordances.
- `phase-7-sharing-gateway-extraction-and-transport.md`: Deferred expansion for
  password/public sharing, friendly slug overrides, gateway extraction,
  horizontal scaling, and QUIC/HTTP/3.
- `phase-8-local-https-dev.md`: Optional mkcert+Caddy local HTTPS parity
  profile for embedded proxy-cookie testing, local host routing, env examples,
  and README/getting-started updates.
- `progress-checklist.md`: Phase-by-phase completion tracker.
- `validation-checklist.md`: Security, protocol, browser, mobile, daemon, and
  production validation checklist.

## Related Design Documents

- `design/web-serving-productization-plan.md`
- `design/web-serving-preview-domain-architecture.md`
- `design/network-upgrade-web-serving-productization.md`
- `design/network-upgrade-quic-transport.md`
- `design/network-upgrade-file-serving-productization.md`

## Primary Areas Expected To Change

- `service/src/db/`: proxied site, thread attachment, viewer grant/session
  schema and ownership helpers.
- `service/src/routes/`: Bud/thread REST routes, viewer-grant route, and
  gateway/auth bootstrap routes.
- `service/src/proxy/`: gateway routing, HTTP request forwarding, WebSocket
  forwarding, and daemon proxy-session coordination.
- `service/src/buds/` and runtime connection code: daemon capability detection,
  target validation requests, proxy request/response frames, and lifecycle
  cleanup on disconnect.
- `service/src/agent/`: `web_view` tools and prompt guidance.
- `web/src/`: workbench web-view pane, hooks, site picker, iframe fallback, and
  state synchronization.
- iOS client: open/attach proxied sites through hosted URLs and cookie-backed
  auth rather than custom navigation headers.
- `docs/proto.md`: Bud-service proxy request, response, body, and WebSocket
  frames when those contracts are implemented.

## Fixed Direction

- Use `bud.dev` for the app/API/auth origin and `bud.show` for proxied
  endpoint hosts.
- Default to generated-friendly endpoint hosts with random suffixes, while
  leaving room for owner-selected friendly slugs later.
- Keep private owner-only access as the first access policy.
- Match Better Auth defaults for proxy viewer cookies: a 7-day session cookie
  with roughly daily refresh/update while the owner remains authenticated.
- Use a long soft TTL for proxied sites and renew while the Bud is active.
- Start co-located in the service process. Extract a separate gateway only when
  traffic volume or horizontal scaling needs justify it.

## Open Decision Gates

- Whether agent-created durable private sites need an explicit user
  confirmation step before creation.
- Whether the first production rollout needs a configurable per-user or
  per-Bud port allowlist beyond daemon-side loopback validation.
- Whether Next.js HMR should become a follow-up validation target after Vite,
  or remain outside the first WebSocket/HMR productization pass.
- Whether generated UI observation becomes a separate `web_view.observe` tool
  or remains out of scope until a later browser-automation capability exists.
