# Phase 5b: Gateway Upgrade And Browser Bridge

## Objective

Expose authorized browser WebSocket upgrades on proxy endpoint hosts and bridge
them to the daemon WebSocket proxy runtime from Phase 5a.

After this phase, a browser can connect to a private `bud.show` /
`proxy.localhost` WebSocket endpoint and exchange messages with a local
loopback WebSocket server on the daemon host.

## Scope

- Add proxy endpoint-host WebSocket upgrade handling in the service.
- Authorize viewer cookies before accepting/bridging upgrades.
- Resolve endpoint host to `proxied_site` before daemon state allocation.
- Bridge browser text/binary frames to daemon WebSocket proxy messages.
- Preserve close code/reason where possible.
- Enforce per-site and per-Bud WebSocket limits.
- Clean up on browser close, site disable/expiry, daemon disconnect, and idle
  timeout.

## Non-Goals

- No Vite HMR-specific tuning yet beyond generic WebSocket correctness.
- No public/password sharing.
- No local HTTPS implementation.
- No request body or expanded HTTP method work.

## Gateway Flow

For a browser upgrade request:

1. Confirm the request host is a configured proxy endpoint host.
2. Resolve the endpoint host to a `proxied_site`.
3. Reject disabled, expired, or unsupported access policy.
4. Resolve and validate the endpoint-host viewer cookie.
5. Verify transport and daemon WebSocket proxy capability.
6. Enforce per-site and per-Bud connection limits.
7. Accept the browser WebSocket upgrade.
8. Open the daemon WebSocket proxy session.
9. Bridge text/binary frames both directions.
10. Close both sides on disable, expiry, Bud disconnect, idle timeout, or
    browser disconnect.

Authorization must happen before daemon operation/session allocation. If the
framework requires accepting before some checks, the implementation must prove
no local daemon work occurs until authorization succeeds.

## Header And Subprotocol Policy

Preserve:

- path and query
- `Sec-WebSocket-Protocol` values that pass validation
- text vs binary message type
- close code and close reason where supported

Strip:

- Bud app cookies and auth headers
- proxy viewer cookies before the local target
- unknown proxy authorization headers
- WebSocket extensions until explicitly supported

Host/origin behavior:

- upstream `Host` defaults to target host/port
- `Origin` behavior is a phase-start decision:
  - preserving browser endpoint origin is more honest
  - rewriting to target origin may improve local-dev compatibility
  - the decision should be validated against Vite before Phase 5c

## Limits

Suggested first defaults:

- per-site active WebSockets: 16
- per-Bud active WebSockets: 64
- open timeout: 10 seconds
- idle timeout: 10 minutes
- max message size: configurable; start conservative and align with service and
  daemon library limits

## Tests

Add tests for:

- unauthenticated upgrade does not allocate daemon state
- signed-in non-owner cannot upgrade
- invalid viewer cookie cannot upgrade
- disabled/expired site blocks upgrade
- authorized browser connects to local echo server
- text frames round-trip
- binary frames round-trip
- browser close closes daemon session
- local close closes browser session
- Bud disconnect closes active browser sockets
- per-site and per-Bud limits are enforced
- reserved cookies and Bud credentials are stripped

## Spec Files To Update During Implementation

- `service/src/routes/routes.spec.md`
- `service/src/proxy/proxy.spec.md`
- `service/src/transport/transport.spec.md`
- `docs/proto.md` if browser-visible behavior is documented there

## Acceptance Criteria

- Browser-to-local WebSocket echo works through a private endpoint host.
- Unauthorized upgrade attempts fail before daemon work is allocated.
- Text, binary, close, and error behavior are deterministic.
- Active sockets are cleaned up on browser close, site disable/expiry, and Bud
  disconnect.
