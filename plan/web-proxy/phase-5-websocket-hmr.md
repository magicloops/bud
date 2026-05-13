# Phase 5: WebSocket And HMR Fidelity

## Objective

Support browser WebSocket upgrades through `bud.show` so modern dev servers and
apps can use HMR and app-level real-time connections. Vite HMR is the first
acceptance target.

## Scope

- Add gateway WebSocket upgrade handling for authorized endpoint hosts.
- Bridge browser WebSockets to daemon proxy WebSocket sessions.
- Add daemon local WebSocket client support to loopback targets.
- Preserve path, query, subprotocols, binary/text frames, close codes, and
  ping/pong behavior where possible.
- Add limits, idle timeouts, and cleanup on disconnect/disable.
- Add Vite HMR smoke validation.

## Non-Goals

- No public sharing.
- No arbitrary upstream hosts.
- No full local HTTPS or WSS-to-local-HTTPS requirement.
- No guarantee that every framework-specific HMR mode works in this phase.

## Gateway Flow

For a browser upgrade request:

1. Resolve endpoint host to `proxied_site`.
2. Validate viewer cookie and owner access before accepting the upgrade.
3. Verify Bud daemon is connected and advertises WebSocket proxy capability.
4. Allocate a proxy WebSocket stream ID.
5. Ask daemon to open a local WebSocket to target host/port/path/query.
6. Bridge browser frames and daemon frames bidirectionally.
7. Close both sides on disable, expiry, Bud disconnect, idle timeout, or
   browser disconnect.

## Target Behavior

Preserve:

- path and query, for example `/@vite/client` and HMR socket paths
- `Sec-WebSocket-Protocol` when safe
- text frames
- binary frames
- close codes and close reasons, subject to framework limitations
- ping/pong or keepalive behavior

Strip:

- Bud credentials
- proxy viewer cookies before local target
- hop-by-hop headers not required for the local upgrade
- unknown proxy authorization headers

Host behavior:

- Default upstream `Host` remains target host/port.
- Preserve `Origin` only if local-dev compatibility requires it. Otherwise
  consider rewriting origin to the endpoint host. This is a phase-start
  security/compatibility decision because dev servers differ in origin checks.

## Daemon Protocol Work

Add WebSocket proxy frames, for example:

- `proxy_ws_open`
- `proxy_ws_opened`
- `proxy_ws_frame`
- `proxy_ws_ping`
- `proxy_ws_pong`
- `proxy_ws_close`
- `proxy_ws_error`

Frame requirements:

- Include `proxied_site_id` or request/session ID as appropriate.
- Use `snake_case` fields.
- Preserve binary/text distinction.
- Support backpressure or bounded queues so one slow side cannot exhaust
  memory.
- Include cancellation semantics when either side closes.

## Limits

Suggested defaults:

- Per-site WebSocket connections: 16.
- Per-Bud WebSocket connections: 64.
- Idle timeout: 10 minutes without app or protocol activity, configurable.
- Open timeout: 10 seconds.
- Max frame size: align with chosen Rust/websocket libraries and service memory
  limits.

## Vite Acceptance Target

Validation app:

- Run a Vite dev server on the daemon host.
- Create a proxied site for the Vite port.
- Open the endpoint host in Chrome.
- Confirm initial HTML, `/@vite/client`, module assets, and HMR socket connect.
- Edit a component and confirm the page updates without manual reload.

Known follow-up target:

- Next.js HMR can be validated after Vite works because it may have different
  paths and dev-server assumptions.

## Error Handling

Browser-facing errors:

- Unauthorized upgrade: reject before upgrade if possible.
- Bud offline: `503` or close with product-safe reason after upgrade if state
  changes.
- Site disabled/expired: close active sockets.
- Local connection refused: product-safe close/error, logged with local target
  metadata.

Logging:

- Log endpoint host, proxied site ID, Bud ID, method/path, and error code.
- Do not log cookies, grants, request bodies, or WebSocket payloads.

## Tests

Add tests for:

- Unauthorized WebSocket request does not allocate daemon state.
- Authorized WebSocket connects to local loopback test server.
- Text and binary frames round-trip.
- Close codes propagate.
- Site disable closes active sockets.
- Bud disconnect closes active sockets.
- Per-site and per-Bud limits are enforced.
- Reserved cookies and Bud credentials are stripped.
- Vite HMR smoke test passes in supported local/dev environment.

## Spec Files To Update During Implementation

- `docs/proto.md`
- `service/src/proxy/proxy.spec.md`
- `bud/src/src.spec.md`
- relevant runtime/connection specs for limits and cleanup

## Acceptance Criteria

- Vite HMR works through a private owner-only `bud.show` endpoint in Chrome.
- App-level WebSocket echo tests pass for text and binary frames.
- Unauthorized upgrade attempts are rejected before daemon state allocation.
- Active sockets close promptly on disable, expiry, or daemon disconnect.
- Protocol docs describe WebSocket proxy frames and lifecycle.
