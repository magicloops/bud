# Web Proxy Progress Checklist

## Phase 1: Proxied Site Resource And Product Routes

- [x] Add `proxied_site` schema.
- [x] Add `thread_web_view` schema.
- [x] Generate and review Drizzle migration.
- [x] Add ownership-aware proxied-site helpers.
- [x] Add Bud-scoped create/list routes.
- [x] Add proxied-site get/update/delete routes.
- [x] Add thread web-view attach/detach routes.
- [x] Add generated-friendly slug/endpoint allocation.
- [x] Add 90-day soft TTL and renewal metadata.
- [x] Add route and ownership tests.
- [x] Update touched specs.

## Phase 2: Proxy Domain Gateway And Private Auth

- [x] Add proxy domain configuration.
- [x] Add `proxied_site_viewer_grant` schema.
- [x] Add `proxied_site_viewer_session` schema.
- [x] Add viewer-grant route.
- [x] Add `bud.show` bootstrap route.
- [x] Set 7-day viewer cookie with 1-day refresh/update behavior.
- [x] Add endpoint-host gateway resolver.
- [x] Add authorized `GET`/`HEAD` proxy path.
- [x] Add daemon loopback validation for web proxy requests.
- [x] Add local `proxy.localhost` development route.
- [ ] Add gateway auth/security tests.
- [x] Update touched specs and protocol docs.

## Phase 3: Web And Mobile Client Surfaces

- [x] Add web proxied-site data hook.
- [x] Add thread web-view hook/state.
- [x] Add Web view pane controls.
- [x] Add existing-site picker.
- [x] Add iframe bootstrap flow.
- [x] Add standalone fallback flow.
- [ ] Add reload/detach/disable/open/copy controls.
- [ ] Add SSE state handling.
- [ ] Define and validate iOS client flow.
- [ ] Add UI tests.
- [x] Update touched web/client specs.

## Phase 4: HTTP Fidelity, Request Bodies, And Cookies

Current recommendation: pause the broader Phase 4 work until Phase 5
Prep-5c lands, because Vite dev/HMR is blocked on WebSocket support rather than
HTTP request-body or local-cookie fidelity.

- [ ] Expand allowed methods.
- [ ] Add 10 MB buffered request body support.
- [ ] Add daemon request body frames.
- [ ] Add cancellation on browser disconnect.
- [ ] Add local app cookie forwarding.
- [ ] Add `Set-Cookie` filtering and reserved-name protection.
- [ ] Add redirect rewriting for local target URLs.
- [ ] Add header stripping and forwarding tests.
- [ ] Update `docs/proto.md`.
- [ ] Update touched service/daemon specs.

## Phase 5 Prep: Observability And Proxy Hardening

- [ ] Add service-side reset error-code/details logging.
- [ ] Add daemon-side inbound reset error-code/details logging.
- [ ] Add gateway auth/security tests for grant, cookie, disabled/expired, and auth-before-daemon-work behavior.
- [ ] Surface current WebSocket/HMR unsupported capability in API/tool/UI state.
- [ ] Add reset-storm validation runbook.
- [ ] Update touched specs.

## Phase 5a: Protocol And Daemon WebSocket Bridge

- [ ] Define WebSocket proxy frame family.
- [ ] Update `docs/proto.md` and protobuf envelope mappings.
- [ ] Add daemon WebSocket proxy capability advertisement.
- [ ] Add daemon local loopback WebSocket client.
- [ ] Add service daemon-facing WebSocket proxy runtime.
- [ ] Preserve text/binary messages and close semantics.
- [ ] Add frame-size, idle, and open-timeout limits.
- [ ] Add daemon/service echo tests.
- [ ] Update touched service/daemon specs.

## Phase 5b: Gateway Upgrade And Browser Bridge

- [ ] Add proxy endpoint-host WebSocket upgrade authorization.
- [ ] Bridge browser WebSockets to daemon WebSocket proxy sessions.
- [ ] Enforce per-site and per-Bud connection limits.
- [ ] Close sockets on browser close, site disable/expiry, and daemon disconnect.
- [ ] Strip Bud credentials and proxy viewer cookies before local target.
- [ ] Add browser-to-local echo tests for text, binary, and close behavior.
- [ ] Update touched service route/proxy/transport specs.

## Phase 5c: Vite HMR Validation And Product Hardening

- [ ] Validate Vite HMR socket connects through endpoint host.
- [ ] Validate Vite component edits update without manual reload.
- [ ] Tune Host/Origin/subprotocol behavior for Vite.
- [ ] Add product-visible WebSocket unsupported/error states.
- [ ] Add production/local WebSocket upgrade deployment checks.
- [ ] Add Vite HMR regression smoke coverage.
- [ ] Update `docs/proto.md`.
- [ ] Update touched web/agent/service specs.

## Phase 6: Agent Tools And Generated UI

- [x] Add `web_view.open`.
- [x] Add `web_view.close`.
- [x] Add `web_view.list`.
- [x] Update agent prompt/tool guidance.
- [x] Wire tool-created attachments to events and UI state.
- [ ] Add message affordance for opened web views.
- [ ] Add tool authorization tests.
- [ ] Confirm user-confirmation decision for durable agent-created sites.
- [x] Update touched agent/web specs.

## Phase 7: Sharing, Gateway Extraction, And Transport Evolution

- [ ] Design password access policy.
- [ ] Design public access policy.
- [ ] Design owner-friendly slug override flow.
- [ ] Define gateway extraction trigger metrics.
- [ ] Design dedicated gateway deployment topology.
- [ ] Revisit QUIC/HTTP/3 after HTTP/WebSocket fidelity is stable.

## Phase 8: Local HTTPS Dev With mkcert And Caddy

- [ ] Add checked-in local HTTPS Caddyfile/template.
- [ ] Add mkcert setup helper or documented command sequence.
- [ ] Add `.certs/` gitignore coverage for local certificates.
- [ ] Add HTTPS env examples for service, web, and daemon.
- [ ] Validate Better Auth callbacks through `https://app.bud.localhost`.
- [ ] Validate API, SSE, and Bud WebSocket traffic through Caddy.
- [ ] Validate `*.proxy.bud.localhost` host preservation into Fastify.
- [ ] Validate embedded Web view bootstrap with `SameSite=None; Secure`.
- [ ] Update root README/getting-started docs.
- [ ] Update package README docs for service, web, and daemon.

## Cross-Phase Release Readiness

- [x] Private owner-only access is enforced before daemon streams open.
- [x] Non-owner signed-in access returns `404`.
- [x] Unauthenticated access returns `401` or product-safe private access page.
- [x] Bud credentials are never forwarded to local apps.
- [x] Target host policy is enforced by service and daemon.
- [ ] Disabled/expired/offline states are visible in web and mobile clients.
- [x] Local development setup is documented and simple.
- [ ] Production wildcard DNS/TLS configuration is documented before rollout.
