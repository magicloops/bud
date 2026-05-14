# proxy

Daemon-side localhost HTTP and WebSocket proxy adapter for the web-proxy network upgrade.

## Purpose

This folder owns the daemon's local adapter for service-requested localhost proxy streams. It revalidates service `proxy_open` and `proxy_ws_open` requests against daemon-side policy before touching loopback resources, performs the local HTTP or WebSocket request, and streams HTTP response bytes or WebSocket messages over the active daemon transport.

## Files

### `mod.rs`

Phase 4.2 localhost proxy implementation, now also used by the durable
product web-proxy gateway.

- accepts `proxy_open` and `proxy_ws_open` frames from the app dispatcher
- only permits `stream_type = "localhost_http_proxy"`
- only permits `stream_type = "localhost_websocket_proxy"` for WebSocket opens
- only permits loopback target hosts: `127.0.0.1`, `::1`, or exact `localhost`
- revalidates `localhost` DNS resolution before opening the local request and
  rejects any non-loopback address
- permits `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`
- accepts bounded request bodies declared by `proxy_open.request_body_bytes`
  and delivered as same-stream `stream_data` before opening the local request
- uses a reqwest client configured by `app.rs` with redirects disabled
- forwards a small allowlist of service-filtered request headers, including
  endpoint-host local-app `cookie` headers when the service includes one
- returns sanitized response headers plus multi-valued local `set_cookies`
  through `proxy_open_result`
- sends response body chunks as generic `stream_data` frames over the active data-plane carrier
- waits for service `stream_credit` before sending more response bytes
- stops active streams when service sends `stream_reset`, including browser
  disconnect cancellation before or during the local request
- dials first-pass local `ws://<loopback-host>:<port><path>` targets for WebSocket proxy sessions
- forwards a bounded, validated list of requested WebSocket subprotocols to the local target
- preserves WebSocket text/binary message boundaries through `proxy_ws_message`
- propagates close/error state through `proxy_ws_close` and `proxy_ws_error`
- stops active WebSocket sessions when service sends `proxy_ws_close` or `proxy_ws_error`

## Dependencies

- [../app.rs](../app.rs) - dispatches `proxy_open` / `proxy_ws_open`, owns the no-redirect HTTP client, and routes WebSocket/HTTP2 data-stream credit/reset plus WebSocket proxy frames into the manager
- [../transport.rs](../transport.rs) - routes generic stream frames over WebSocket or attached gRPC data according to the active transport
- [../protocol.rs](../protocol.rs) - `ProxyOpenFrame`, `ProxyWebSocket*Frame`, `StreamDataFrame`, `StreamCreditFrame`, and `StreamResetFrame` definitions
- [../../src.spec.md](../src.spec.md) - daemon source overview
- [../../../plan/network-upgrade/phase-4-localhost-proxy-and-file-reads.md](../../../plan/network-upgrade/phase-4-localhost-proxy-and-file-reads.md) - Phase 4 sequencing
- [../../../plan/web-proxy/implementation-spec.md](../../../plan/web-proxy/implementation-spec.md) - durable proxied-site product plan built on this local adapter

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Later proxy work needs richer local policy configuration, local `wss://`
  targets, full browser/local subprotocol selection parity, streaming uploads
  beyond the bounded-buffer path, and stream outcome audit coverage beyond the
  service's current durable operation/stream rows.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
