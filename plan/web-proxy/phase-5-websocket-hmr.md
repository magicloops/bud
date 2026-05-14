# Phase 5: WebSocket And HMR Fidelity

## Objective

Support browser WebSocket upgrades through `bud.show` / `proxy.localhost` so
modern dev servers and app-level real-time connections work through the Bud
daemon. Vite HMR is the first full-fidelity acceptance target.

This phase is now split into smaller sub-phases because WebSocket/HMR touches
the browser gateway, service auth, daemon protocol, daemon local networking,
stream lifecycle, and frontend/product diagnostics.

## Why Split This Phase

The HTTP proxy spike proved that owner-private endpoint-host routing works for
normal `GET`/`HEAD` traffic. The Vite dev-server test showed the next blocker is
not another HTTP transport issue; it is missing browser WebSocket upgrade
support and missing HMR diagnostics.

Splitting Phase 5 lets us:

- harden current reset/authorization visibility before adding new protocol
  surface
- land daemon protocol and local WebSocket support independently from browser
  upgrade routing
- validate the service browser bridge with simple echo tests before Vite HMR
- keep Phase 4 HTTP bodies/cookies separate from the HMR-critical path

## Sub-Phases

| Sub-phase | Outcome | Primary Proof |
| --- | --- | --- |
| [Phase 5 Prep](./phase-5-prep-observability-and-hardening.md) | Current HTTP proxy reset/auth behavior is diagnosable and unsupported HMR is explicit. | Reset error codes are visible; gateway auth tests cover no-stream-before-auth. |
| [Phase 5a](./phase-5a-protocol-and-daemon-websocket-bridge.md) | Service and daemon have a WebSocket proxy protocol and daemon local loopback WS adapter. | Local daemon WS echo bridge can be driven without browser gateway upgrade. |
| [Phase 5b](./phase-5b-gateway-upgrade-and-browser-bridge.md) | Proxy endpoint hosts accept authorized browser upgrades and bridge frames to daemon WS sessions. | Browser-to-local echo server works for text, binary, and close semantics. |
| [Phase 5c](./phase-5c-vite-hmr-validation-and-product-hardening.md) | Vite HMR is validated through the proxy endpoint host. | Vite component edit updates without manual reload through the proxied endpoint. |
| [Phase 5d](./phase-5d-websocket-regression-and-failure-states.md) | WebSocket/HMR behavior is covered by regression tests and useful product failure states. | Echo tests cover text/binary/close/disconnect; web/agent surfaces avoid generic loading errors. |

## Recommended Sequence

Do Phase 5 before Phase 4 HTTP body/cookie work.

Reasoning:

- HMR is a hard blocker for the core local-development workflow.
- `vite preview` already validates that simple HTTP traffic can work.
- Request bodies and local-app cookies are important for interactive apps, but
  they do not fix Vite dev mode.
- WebSocket support adds new daemon protocol and gateway lifecycle concepts that
  should be validated before expanding HTTP method/body complexity.

## Cross-Phase Design Direction

Prefer message-oriented WebSocket proxy frames over forcing browser WebSocket
traffic through the existing HTTP `stream_data` response-byte contract.

Reasons:

- WebSockets are bidirectional and message-framed, not unidirectional HTTP
  response streams.
- Text/binary distinction, close code/reason, and ping/pong behavior matter.
- Existing `stream_data` receive-offset validation is useful for file/HTTP
  byte streams but awkward for full-duplex WebSocket message semantics.
- A dedicated frame family keeps auth, limits, and cleanup explicit.

The final frame names can change during Phase 5a, but the conceptual frame
family should include:

- open request
- open result
- message frame, preserving text vs binary
- close frame, preserving code/reason where supported
- error/reset frame
- optional ping/pong frames if the chosen libraries do not handle them cleanly

## Non-Goals

- No public sharing.
- No arbitrary upstream hosts.
- No full local HTTPS or WSS-to-local-HTTPS requirement.
- No request-body or local-app cookie expansion; those remain Phase 4.
- No guarantee that every framework-specific HMR mode works in this phase.
- No QUIC/HTTP/3 dependency.

## Current Validation Status

As of May 13, 2026, the Vite acceptance path has been manually validated:

- the proxied Vite dev server loads through the endpoint host
- the HMR WebSocket connects through the proxy
- editing a source file updates the page live without manual reload

The remaining Phase 5 work is now regression coverage, lifecycle cleanup, and
product-visible failure states rather than basic HMR feasibility.

## Acceptance Criteria

Phase 5 is complete when:

- Vite HMR works through a private owner-only endpoint host in Chrome.
- App-level WebSocket echo tests pass for text and binary frames.
- Unauthorized upgrade attempts are rejected before daemon state allocation.
- Active sockets close promptly on site disable, expiry, browser close, or
  daemon disconnect.
- Per-site and per-Bud WebSocket limits are enforced.
- Web and agent surfaces show specific proxy/WebSocket failure states instead
  of generic loading or generic JSON errors.
- Protocol docs describe WebSocket proxy frames and lifecycle.
- Progress and validation checklists are updated.
