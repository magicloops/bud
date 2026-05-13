# Phase 5a: Protocol And Daemon WebSocket Bridge

## Objective

Add the Bud-service protocol and daemon local loopback adapter needed to bridge
WebSocket connections, without yet exposing a browser-facing proxy-domain
upgrade route.

After this phase, the service should be able to ask a connected daemon to open a
local `ws://<loopback-host>:<port><path>` connection and exchange text/binary
messages through a bounded, authenticated daemon transport path.

## Scope

- Define WebSocket proxy protocol frames.
- Add protocol schemas and protobuf envelope support where required.
- Add daemon capability advertisement for WebSocket proxy support.
- Add daemon loopback WebSocket client support.
- Add bounded queues/backpressure and max-frame validation.
- Add daemon/service tests that prove local echo behavior without browser
  endpoint-host routing.

## Non-Goals

- No browser gateway WebSocket upgrade route.
- No Vite HMR validation yet.
- No public/password sharing.
- No local `wss://` target support in the first pass.
- No arbitrary upstream hosts.

## Protocol Direction

Prefer a dedicated message-oriented frame family rather than reusing
unidirectional HTTP `stream_data` response semantics.

Candidate frame family:

- `proxy_ws_open`: service to daemon
- `proxy_ws_open_result`: daemon to service
- `proxy_ws_message`: bidirectional text/binary payload
- `proxy_ws_close`: bidirectional close code/reason
- `proxy_ws_error`: bidirectional terminal error/reset
- optional `proxy_ws_ping` and `proxy_ws_pong` if library-level handling is not
  sufficient

Frame fields should be `snake_case` and include:

- `operation_id`
- `ws_session_id` or `stream_id`
- `proxied_site_id` or proxy resource id where appropriate
- `target_host`
- `target_port`
- `path`
- safe selected headers/subprotocols
- monotonically increasing message sequence numbers if needed for diagnostics
- text payload or base64 binary payload
- close code and close reason where supported

Open-result should include:

- `accepted`
- `selected_protocol`
- safe response headers if useful
- typed error code/message/retryable when rejected

## Daemon Adapter

Daemon should:

- validate target host against `127.0.0.1`, `::1`, or exact `localhost`
- revalidate `localhost` resolution as loopback
- connect to `ws://` local targets only in the first pass
- preserve path and query
- pass allowed subprotocols when safe
- avoid forwarding Bud credentials or proxy viewer cookies
- preserve text and binary messages
- propagate close code/reason where supported by the library
- close local socket on service close/reset
- close service session on local socket close/error
- enforce max frame size and idle timeout

Likely Rust dependency:

- reuse `tokio-tungstenite` if available and suitable for client connections

## Service Runtime

Service should add a daemon-facing WebSocket proxy runtime that can be driven by
tests without browser upgrade handling.

Responsibilities:

- allocate operation/session ids
- send `proxy_ws_open`
- wait for `proxy_ws_open_result`
- send and receive message frames
- enforce max frame size
- enforce idle/open timeouts
- clean up on daemon disconnect
- record safe audit/log events

## Tests

Add tests for:

- daemon rejects unsupported target host
- daemon rejects unsupported local scheme
- daemon opens local loopback echo WebSocket
- text message round-trip
- binary message round-trip
- local close propagates to service
- service close propagates to local target
- oversized frames are rejected
- idle timeout closes the session
- daemon disconnect cleans up service runtime

## Spec Files To Update During Implementation

- `docs/proto.md`
- `proto/bud/v1/bud.proto`
- `service/src/proto/proto.spec.md`
- `service/src/proxy/proxy.spec.md`
- `service/src/transport/transport.spec.md`
- `bud/src/src.spec.md`
- `bud/src/proxy/proxy.spec.md`

## Acceptance Criteria

- A service-side test can drive a daemon-backed local WebSocket echo connection.
- Text and binary payloads round-trip over the Bud daemon transport.
- Close/error behavior is deterministic and logged with safe typed codes.
- Daemon advertises a distinct WebSocket proxy capability.
- Protocol docs describe the new frame family.
