# Phase 5d: WebSocket Regression And Failure States

## Objective

Lock in the now-working WebSocket/HMR proxy behavior with regression coverage
and product-visible failure states.

Phase 5c validated the core Vite path manually: a proxied Vite dev server can
connect its HMR socket through the proxy endpoint host, and editing a source
file updates the page live. Phase 5d turns that success into a dependable
product surface.

## Scope

- Add daemon/service WebSocket echo tests for text, binary, close, and error
  behavior.
- Add browser-to-local gateway echo tests for authorized endpoint-host
  WebSocket upgrades.
- Add lifecycle cleanup tests for browser close, Bud disconnect, site disable,
  and site expiry.
- Add product-visible web-view failure states for WebSocket and proxy
  failures.
- Add agent/tool result messaging that distinguishes static HTTP preview from
  full WebSocket/HMR support.
- Add a manual Vite HMR smoke runbook that can be repeated before release.

## Non-Goals

- No broad framework guarantee beyond Vite.
- No public/password sharing.
- No local HTTPS implementation; that remains Phase 8.
- No request-body, mutation-method, or local-app cookie work; that remains
  Phase 4.

## Regression Coverage

Daemon/service tests should prove:

- daemon rejects unsupported WebSocket target hosts
- daemon revalidates `localhost` as loopback
- service sends `proxy_ws_open` only after authorization
- text frames round-trip
- binary frames round-trip
- local close propagates to browser/service
- browser/service close propagates to the local WebSocket
- oversized frames are rejected with a typed error
- open timeout and idle timeout close both sides
- daemon disconnect closes active browser sockets

Browser gateway tests should prove:

- unauthenticated upgrade does not allocate daemon state
- invalid viewer cookie does not allocate daemon state
- disabled and expired sites block upgrades
- per-site and per-Bud WebSocket limits are enforced
- pending browser messages sent before local open are bounded and then flushed
  after open
- reserved cookies and Bud credentials are not forwarded to the local target

## Product Failure States

The web view should avoid indefinite loading states. First-pass product states:

- **Bud offline**: the proxied site exists, but no usable daemon carrier is
  connected.
- **WebSocket unsupported**: static HTTP preview may work, but HMR/app sockets
  are unavailable with the current daemon or transport.
- **Local connect failed**: the daemon could not connect to the requested local
  host/port/path.
- **Proxy auth blocked**: the endpoint-host viewer session is missing or
  invalid; show the existing standalone/open-new-window recovery path where
  appropriate.
- **Site disabled or expired**: the durable proxied site is no longer openable.
- **Connection limit exceeded**: per-site or per-Bud WebSocket limits blocked
  the connection.
- **Transport lost**: the daemon disconnected or the selected carrier reset
  while the proxied site was open.

These states should be visible in both embedded and standalone web-view
surfaces where possible. For embedded iframes, some failures may only be
observable through the owning Bud app state rather than inside the iframe.

## Agent And Tool Behavior

`web_view.open` / `web_view.list` should keep reporting both HTTP and WebSocket
transport availability.

If WebSocket support is unavailable, the assistant should phrase the outcome as:

- the web view was opened for static HTTP preview when HTTP transport is
  available
- Vite HMR or app-level WebSockets will not work until the Bud reconnects with
  WebSocket proxy support

Tool results must continue to omit viewer grants, cookies, and raw daemon
stream ids.

## Manual Smoke Runbook

Repeat before release:

1. Start service, web, and a connected Bud daemon.
2. Start a Vite dev server on the daemon host.
3. Open a proxied site for the Vite port.
4. Open the endpoint host in Chrome.
5. Confirm root HTML, `/@vite/client`, module assets, and favicon requests
   succeed.
6. Confirm the HMR WebSocket connects through the endpoint host.
7. Edit a component and confirm the page updates without manual reload.
8. Let the page idle for at least one minute and confirm there is no
   request/reset storm.
9. Disconnect the daemon and confirm the browser/web UI exits the loading state
   with a useful failure.
10. Reconnect the daemon and confirm a reload recovers.

## Spec Files To Update During Implementation

- `service/src/proxy/proxy.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/ws/ws.spec.md`
- `web/src/features/threads/threads.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `service/src/agent/agent.spec.md`
- `docs/proto.md` if frame shapes or lifecycle semantics change

## Acceptance Criteria

- Vite HMR remains green in the manual smoke runbook.
- Echo tests cover text, binary, close, and daemon disconnect behavior.
- Unauthorized and invalid-cookie upgrades fail before daemon work allocation.
- Active WebSockets close promptly on site disable, site expiry, browser close,
  and daemon disconnect.
- Web and agent surfaces show useful proxy/WebSocket failure states instead of
  generic loading or generic JSON errors.

## Implementation Notes

- Confirmed and fixed the initial proxied-page `FINAL_OFFSET_MISMATCH` race
  where WebSocket carrier callbacks could let `stream_close` reach the
  data-plane runtime before the preceding `stream_data`. The shared
  data-plane runtime now serializes lifecycle handling per `stream_id`, and the
  WebSocket gateway dispatches stream frames before throttled activity
  heartbeat writes.
- Removed temporary per-frame debug instrumentation after confirmation; the
  behavior is now protected by focused service regressions instead of timing
  side effects from logs.
- Added service runtime regression coverage for text/binary forwarding, daemon
  open/close dispatch, oversized browser-message errors, and site-level active
  session cleanup.
- Added gateway route coverage proving missing/invalid viewer cookies and
  disabled/expired sites reject WebSocket upgrades before opening daemon work.
- Added gateway route coverage proving an authorized endpoint-host WebSocket
  upgrade dispatches `proxy_ws_open` only after viewer-cookie auth, preserves
  request path/query, and sanitizes requested subprotocols.
- Added gateway route coverage for per-site and per-Bud WebSocket connection
  limits, including rejection before daemon operation allocation.
- Added service cleanup hooks so disabling a durable proxied site closes active
  WebSocket sessions, and open WebSocket sessions schedule site-expiry closure.
- Added runtime-level coverage for closing all active WebSocket sessions for a
  Bud when the selected carrier is lost.
- Added separate `websocket_transport` readiness to proxied-site API/tool
  payloads and web-view UI state, with pane banners for Bud offline,
  disabled/expired sites, and WebSocket/HMR unavailable states.
- Added agent summaries that distinguish static HTTP preview availability from
  full WebSocket/HMR support.

Remaining hardening after this pass:

- Daemon/local echo integration tests.
- Browser-to-local authorized gateway echo tests.
- End-to-end daemon-disconnect cleanup regression test.
- Product telemetry for local WebSocket connect failures and connection-limit
  closes inside already-loaded proxied apps.
