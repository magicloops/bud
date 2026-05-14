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

Phase 4a covers the mutation-method/request-body/cancellation subset. Phase 4b
covers endpoint-host local-app cookie round-tripping and reserved cookie
protection. The remaining Phase 4 work is redirects and any future
streaming-upload upgrade.

- [x] Expand allowed methods.
- [x] Add 10 MB buffered request body support.
- [x] Add daemon request body frames.
- [x] Add cancellation on browser disconnect.
- [x] Add local app cookie forwarding.
- [x] Add `Set-Cookie` filtering and reserved-name protection.
- [ ] Add redirect rewriting for local target URLs.
- [ ] Add header stripping and forwarding tests.
- [x] Update `docs/proto.md`.
- [x] Update touched service/daemon specs.

## Phase 5 Prep: Observability And Proxy Hardening

- [ ] Add service-side reset error-code/details logging.
- [ ] Add daemon-side inbound reset error-code/details logging.
- [ ] Add gateway auth/security tests for grant, cookie, disabled/expired, and auth-before-daemon-work behavior.
- [ ] Surface current WebSocket/HMR unsupported capability in API/tool/UI state.
- [ ] Add reset-storm validation runbook.
- [x] Fix and regress per-stream data-plane ordering for back-to-back
  `stream_data` / `stream_close` frames.
- [ ] Update touched specs.

## Phase 5a: Protocol And Daemon WebSocket Bridge

- [x] Define WebSocket proxy frame family.
- [x] Update `docs/proto.md` and protobuf envelope mappings.
- [x] Add daemon WebSocket proxy capability advertisement.
- [x] Add daemon local loopback WebSocket client.
- [x] Add service daemon-facing WebSocket proxy runtime.
- [x] Preserve text/binary messages and close semantics.
- [x] Add frame-size, idle, and open-timeout limits.
- [x] Add service WebSocket runtime text/binary/close/error tests.
- [ ] Add daemon/local WebSocket echo integration tests.
- [x] Update touched service/daemon specs.

## Phase 5b: Gateway Upgrade And Browser Bridge

- [x] Add proxy endpoint-host WebSocket upgrade authorization.
- [x] Bridge browser WebSockets to daemon WebSocket proxy sessions.
- [x] Enforce per-site and per-Bud connection limits.
- [x] Close active sockets on site disable and site expiry.
- [ ] Add daemon-disconnect active WebSocket cleanup regression test.
- [x] Strip Bud credentials and proxy viewer cookies before local target.
- [ ] Add browser-to-local echo tests for text, binary, and close behavior.
- [x] Update touched service route/proxy/transport specs.

## Phase 5c: Vite HMR Validation

- [x] Validate Vite HMR socket connects through endpoint host.
- [x] Validate Vite component edits update without manual reload.
- [x] Tune Host/Origin/subprotocol behavior for Vite.
- [ ] Add production/local WebSocket upgrade deployment checks.
- [x] Update `docs/proto.md`.
- [x] Update touched web/agent/service specs.

## Phase 5d: WebSocket Regression And Failure States

- [x] Add service WebSocket runtime tests for text, binary, close, and error behavior.
- [x] Add data-plane ordering regression coverage for back-to-back data/close
  frames on the WebSocket carrier.
- [ ] Add daemon/local WebSocket echo tests for text, binary, close, and error behavior.
- [ ] Add browser-to-local echo tests for authorized endpoint-host upgrades.
- [x] Add auth-before-daemon-work tests for unauthenticated and invalid-cookie upgrades.
- [x] Add disabled/expired site WebSocket rejection and active-socket cleanup tests.
- [ ] Add daemon-disconnect active WebSocket cleanup test.
- [ ] Add per-site and per-Bud WebSocket limit tests.
- [x] Add product-visible Bud offline, disabled/expired, and WebSocket unsupported/error states.
- [x] Add agent/tool messaging for static HTTP vs full WebSocket/HMR support.
- [x] Add repeatable Vite HMR smoke runbook.
- [ ] Update touched service/web/agent specs.

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
- [x] Disabled/expired/offline states are visible in the web client.
- [ ] Disabled/expired/offline states are visible in the mobile client.
- [x] Local development setup is documented and simple.
- [ ] Production wildcard DNS/TLS configuration is documented before rollout.
