# proxy

Daemon-side localhost HTTP proxy adapter for Phase 4.2 of the network upgrade.

## Purpose

This folder owns the daemon's local adapter for service-requested localhost proxy streams. It revalidates service `proxy_open` requests against daemon-side policy before touching loopback resources, performs the local HTTP request, and streams response bytes over the active data-plane carrier with runtime credits.

## Files

### `mod.rs`

Phase 4.2 localhost proxy implementation.

- accepts `proxy_open` frames from the app dispatcher
- only permits `stream_type = "localhost_http_proxy"`
- only permits `target_host = "127.0.0.1"`
- only permits `GET` and `HEAD`
- uses a reqwest client configured by `app.rs` with redirects disabled
- forwards a small allowlist of request headers
- returns sanitized response headers through `proxy_open_result`
- sends response body chunks as generic `stream_data` frames over the active data-plane carrier
- waits for service `stream_credit` before sending more response bytes
- stops active streams when service sends `stream_reset`

## Dependencies

- [../app.rs](../app.rs) - dispatches `proxy_open`, owns the no-redirect HTTP client, and routes WebSocket/HTTP2 data-stream credit/reset frames into the manager
- [../transport.rs](../transport.rs) - routes generic stream frames over WebSocket or attached gRPC data according to the active transport
- [../protocol.rs](../protocol.rs) - `ProxyOpenFrame`, `StreamCreditFrame`, and `StreamResetFrame` definitions
- [../../src.spec.md](../src.spec.md) - daemon source overview
- [../../../plan/network-upgrade/phase-4-localhost-proxy-and-file-reads.md](../../../plan/network-upgrade/phase-4-localhost-proxy-and-file-reads.md) - Phase 4 sequencing

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Later proxy work needs request bodies, non-GET methods, richer local policy configuration, end-to-end browser validation, and stream outcome audit coverage beyond the service's current durable operation/stream rows.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
