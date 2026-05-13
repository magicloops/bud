# Web Proxy Progress Checklist

## Phase 1: Proxied Site Resource And Product Routes

- [ ] Add `proxied_site` schema.
- [ ] Add `thread_web_view` schema.
- [ ] Generate and review Drizzle migration.
- [ ] Add ownership-aware proxied-site helpers.
- [ ] Add Bud-scoped create/list routes.
- [ ] Add proxied-site get/update/delete routes.
- [ ] Add thread web-view attach/detach routes.
- [ ] Add generated-friendly slug/endpoint allocation.
- [ ] Add 90-day soft TTL and renewal metadata.
- [ ] Add route and ownership tests.
- [ ] Update touched specs.

## Phase 2: Proxy Domain Gateway And Private Auth

- [ ] Add proxy domain configuration.
- [ ] Add `proxied_site_viewer_grant` schema.
- [ ] Add `proxied_site_viewer_session` schema.
- [ ] Add viewer-grant route.
- [ ] Add `bud.show` bootstrap route.
- [ ] Set 7-day viewer cookie with 1-day refresh/update behavior.
- [ ] Add endpoint-host gateway resolver.
- [ ] Add authorized `GET`/`HEAD` proxy path.
- [ ] Add daemon loopback validation for web proxy requests.
- [ ] Add local `proxy.localhost` development route.
- [ ] Add gateway auth/security tests.
- [ ] Update touched specs and protocol docs.

## Phase 3: Web And Mobile Client Surfaces

- [ ] Add web proxied-site data hook.
- [ ] Add thread web-view hook/state.
- [ ] Add Web view pane controls.
- [ ] Add existing-site picker.
- [ ] Add iframe bootstrap flow.
- [ ] Add standalone fallback flow.
- [ ] Add reload/detach/disable/open/copy controls.
- [ ] Add SSE state handling.
- [ ] Define and validate iOS client flow.
- [ ] Add UI tests.
- [ ] Update touched web/client specs.

## Phase 4: HTTP Fidelity, Request Bodies, And Cookies

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

## Phase 5: WebSocket And HMR Fidelity

- [ ] Add gateway WebSocket upgrade authorization.
- [ ] Add daemon local WebSocket client.
- [ ] Add WebSocket proxy protocol frames.
- [ ] Preserve text/binary frames and close semantics.
- [ ] Add per-site and per-Bud connection limits.
- [ ] Close sockets on disable, expiry, and daemon disconnect.
- [ ] Validate Vite HMR.
- [ ] Add WebSocket tests.
- [ ] Update `docs/proto.md`.
- [ ] Update touched service/daemon specs.

## Phase 6: Agent Tools And Generated UI

- [ ] Add `web_view.open`.
- [ ] Add `web_view.close`.
- [ ] Add `web_view.list`.
- [ ] Update agent prompt/tool guidance.
- [ ] Wire tool-created attachments to events and UI state.
- [ ] Add message affordance for opened web views.
- [ ] Add tool authorization tests.
- [ ] Confirm user-confirmation decision for durable agent-created sites.
- [ ] Update touched agent/web specs.

## Phase 7: Sharing, Gateway Extraction, And Transport Evolution

- [ ] Design password access policy.
- [ ] Design public access policy.
- [ ] Design owner-friendly slug override flow.
- [ ] Define gateway extraction trigger metrics.
- [ ] Design dedicated gateway deployment topology.
- [ ] Revisit QUIC/HTTP/3 after HTTP/WebSocket fidelity is stable.
- [ ] Add optional local HTTPS recipe when needed.

## Cross-Phase Release Readiness

- [ ] Private owner-only access is enforced before daemon streams open.
- [ ] Non-owner signed-in access returns `404`.
- [ ] Unauthenticated access returns `401` or product-safe private access page.
- [ ] Bud credentials are never forwarded to local apps.
- [ ] Target host policy is enforced by service and daemon.
- [ ] Disabled/expired/offline states are visible in web and mobile clients.
- [ ] Local development setup is documented and simple.
- [ ] Production wildcard DNS/TLS configuration is documented before rollout.
