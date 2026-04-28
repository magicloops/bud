# Phase 4: Web Proxy Stream Over WebSocket

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented and validated
**Priority**: High

---

## Objective

Make the existing localhost HTTP proxy foundation work over the WebSocket baseline with gRPC disabled.

This is not the full web-serving product. It proves the daemon-service proxy stream contract that the product can later use.

## Current Problem

Phase 1/2 are responsible for the carrier-neutral selector, WebSocket carrier registration, daemon stream-frame capability advertisement, and selected-carrier `proxy_open` routing.

This phase should assume those prerequisites exist and prove the end-to-end proxy stream path with gRPC disabled. The remaining risk is integration: browser proxy edge request → WebSocket `proxy_open` → daemon local loopback policy/request → WebSocket `stream_data`/`stream_close` → HTTP response.

## Target Behavior

With only WebSocket enabled:

- the daemon advertises loopback HTTP proxy support when the WebSocket carrier supports binary envelope stream frames
- the service creates proxy sessions after browser ownership checks
- the service selects an active control carrier to send `proxy_open`
- the service selects an active data carrier that supports `localhost_http_proxy`
- the daemon enforces loopback/method/header policy
- response headers and body stream back over WebSocket stream frames
- resets and closes propagate to the service proxy edge

## Implementation Steps

1. Confirm daemon proxy capability gating uses carrier stream support.
2. Confirm proxy session readiness uses the carrier-neutral data-plane selector.
3. Confirm `proxy_open` uses the selected carrier route.
4. Confirm `proxy_open_result` from WebSocket dispatch reaches the proxy runtime.
5. Confirm `stream_data`, `stream_reset`, and `stream_close` reach active proxy edge streams.
6. Keep existing local proxy policy:
   - loopback only
   - HTTP only
   - `GET` and `HEAD` only
   - no redirects for the first pass
   - sanitized request and response headers
   - response byte limits
7. Add WebSocket-only real-daemon proxy smoke coverage.

## Acceptance Criteria

- [x] Proxy session readiness succeeds for a capable WebSocket-only daemon.
- [x] Proxy session readiness fails with carrier-neutral errors when no data carrier exists.
- [x] `proxy_open` is no longer gRPC-router-only.
- [x] Loopback `GET` smoke passes with gRPC disabled.
- [x] Loopback `HEAD` smoke passes with gRPC disabled.
- [x] Stream closes reach proxy callers.
- [x] Existing HTTP/2 proxy smoke, if retained, still passes through the same runtime boundary.

## Validation

- Unit tests:
  - proxy readiness with WebSocket carrier
  - proxy readiness without proxy stream-family support
  - non-owner access remains denied before stream open
  - daemon denial maps to typed proxy result
  - unsafe targets remain rejected
- Real-daemon smoke:
  - start a local HTTP server on `127.0.0.1`
  - create proxy session as the owner
  - stream `GET` response body over WebSocket
  - stream `HEAD` response metadata over WebSocket
  - force gRPC disabled

Completed validation:

- `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/transport/data-plane-router.test.ts src/files/file-session.test.ts src/proxy/proxy-session.test.ts src/ws/bud-connection.test.ts`
- `pnpm --dir /Users/adam/bud/service build`
- `pnpm --dir /Users/adam/bud/service smoke:ws-proxy`

## Specs To Update

- [x] [../../service/src/proxy/proxy.spec.md](../../service/src/proxy/proxy.spec.md)
- [x] [../../service/src/transport/transport.spec.md](../../service/src/transport/transport.spec.md)
- [x] [../../service/src/ws/ws.spec.md](../../service/src/ws/ws.spec.md)
- [x] [../../bud/src/src.spec.md](../../bud/src/src.spec.md)
- [x] [../../docs/proto.md](../../docs/proto.md)
- [x] [../../service/src/scripts/scripts.spec.md](../../service/src/scripts/scripts.spec.md)

## Non-Goals

- Web proxy browser UX.
- Request bodies.
- Redirect following.
- SSE hardening.
- WebSocket upgrades through the proxy.
- QUIC proxy transport.
