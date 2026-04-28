# Bud Protocol

## Scope

This document specifies the active on-wire contracts used by Bud:

- Bud daemon ⇄ service over WebSocket binary `BudEnvelope` frames at `/ws`; binary WebSocket is the baseline carrier for current terminal/control traffic and generic stream frames when advertised
- Bud daemon ⇄ service over opt-in HTTP/2 gRPC control streams at `bud.v1.BudControl.Connect`
- Bud daemon ⇄ service over opt-in subordinate HTTP/2 gRPC data streams at `bud.v1.BudData.Attach`
- Service → browser over SSE for thread-scoped agent and terminal streams
- Browser → service thread message writes that participate in the live agent-stream contract

The legacy standalone run transport (`run`, `stdout`, `stderr`, `cancel`, `run_finished`) and browser `/api/runs/*` stream are no longer part of the supported contract.

---

## 1. Conventions

- **Bud**: the Rust daemon running on a device
- **Service**: the Node/Fastify backend
- **Browser client**: the web or native product surface consuming REST/SSE
- **Thread**: the user-owned conversation that also owns the active terminal session
- **Terminal session**: the thread-scoped persistent shell/REPL/TUI runtime on Bud
- **Frame**: one logical daemon-service message, carried as a protobuf `BudEnvelope` binary frame on the active daemon WebSocket path
- **Event**: one SSE frame

Identifiers:
- `bud_id`: stable device identifier
- `thread_id`: stable conversation identifier
- `session_id`: stable thread-terminal identifier
- `message_id`: persisted transcript-row identifier
- `client_id`: stable client-visible message identity used across optimistic UI, live runtime, and later persistence
- `request_id`: per-request id for terminal request/response flows

Timestamps:
- `ts` is milliseconds since UNIX epoch on WebSocket frames
- HTTP/SSE payloads use ISO-8601 strings unless noted otherwise

Wire-format rules:
- Bud-owned request/response bodies, SSE payloads, and WebSocket payloads use `snake_case`
- Unknown fields must be ignored
- Every WebSocket frame includes a reserved `ext` object for forward compatibility

---

## 2. Versioning

- Base WebSocket protocol version: `proto: "0.1"`
- Terminal protocol extension version: `proto: "0.2"`
- Unknown fields must be ignored by receivers
- Breaking wire changes must bump the relevant `proto`

---

## 3. Transports

### 3.0 Network Upgrade Transition

The codebase now has a Phase 0 transport boundary for the daemon-network upgrade:

- service runtime code sends ordinary daemon control work through `DaemonTransportRouter`
- the current control router implementation is composite and follows `DAEMON_TRANSPORT_POLICY`; the default `websocket_baseline` policy keeps WebSocket first and uses HTTP/2 as fallback
- file/proxy stream work selects an explicit data-plane carrier instead of hard-coding gRPC control/data
- daemon terminal/run modules send outbound payloads through a transport sender wrapper instead of a raw WebSocket sender type
- shared protobuf schema lives in `proto/bud/v1/bud.proto`
- the shared schema now exposes `service BudControl { rpc Connect(stream BudEnvelope) returns (stream BudEnvelope); }` and `service BudData { rpc Attach(stream BudEnvelope) returns (stream BudEnvelope); }`
- service and daemon both encode/decode `BudEnvelope v1` binary frames for WebSocket-capable peers; active daemon sessions must advertise `bud_envelope.websocket_binary`
- WebSocket-capable peers map active terminal/control and core data-plane lifecycle payloads to typed protobuf fields instead of wrapping the whole JSON frame in `frame_json`; intentionally dynamic nested documents such as capabilities, terminal deltas, readiness, and reconnect details remain explicit JSON/bytes subfields
- service and daemon both use `BudEnvelope v1` on the gRPC control stream, with typed oneof payloads carrying transitional `frame_json`
- WebSocket-capable peers dispatch generic stream/proxy/file foundation frames through typed protobuf oneof payload tags; `data_attach`, `data_attach_ack`, `stream_data`, `stream_credit`, `stream_reset`, and `stream_close` use direct protobuf fields, while proxy/file open payloads remain on the bounded `frame_json` bridge
- `LegacyJsonPayload` remains decode-compatible for older binary fixtures and conformance tests, but it is not part of the active WebSocket daemon path
- terminal output emitted by the daemon is chunked to the documented 16 KiB maximum

The current daemon sends the bootstrap `hello` as a protobuf `BudEnvelope` binary frame. New daemons must advertise `capabilities.bud_envelope = { version: 1, websocket_binary: true, stream_frames: true }` when the active transport mode can carry generic stream frames. After that capability is accepted, service and daemon continue sending protobuf `BudEnvelope` binary frames over the same WebSocket connection; legacy JSON text/binary frames are rejected with `PROTO_VERSION_MISMATCH`, and unknown envelope payload oneof fields are rejected with `UNSUPPORTED_PAYLOAD`. The service may parse a pre-negotiation JSON `hello` only to return a useful protocol error to unsupported clients; it does not register legacy JSON daemon sessions.

Phase 1 durable state now exists in the service schema:

- `device_session` records daemon control-session epochs, capabilities, heartbeat, and drain/close state
- `transport_session` records concrete WebSocket/HTTP2/QUIC transport sessions
- `bud_operation` records daemon-directed operation lifecycle with idempotency and typed error fields
- `bud_stream` records stream lifecycle, byte offsets, credits, reset reasons, and typed stream errors
- `audit_event` is the append-only audit foundation for daemon/session/operation/stream events

The daemon has a local journal foundation for accepted operations, active stream checkpoints, terminal session ids, and local policy version. After a successful handshake, the daemon sends a live `reconnect_report`; the service records an audit event, compares reported operation/stream ids to durable service state, and replies with `reconciliation_decision`. Unknown service-side matches are reported as `unknown` instead of invented success/failure.

Gateway drain is process-local in the current daemon transport adapters. When enabled, the gateway refuses new long-lived daemon work such as `terminal_ensure`, proxy-open, and file-open/read frames while allowing short control traffic to continue. If an active transport closes or times out, affected durable operation and stream rows owned by that transport are marked `unknown`.

Phase 2 gRPC control is opt-in during rollout:

- service starts the grpc-js listener only when `GRPC_CONTROL_ENABLED=true`
- default listener address is `127.0.0.1:50051`
- daemon uses tonic control only when `BUD_GRPC_CONTROL_URL` is set
- if that opt-in gRPC control carrier is unavailable, the daemon falls back to the configured WebSocket server and advertises WebSocket-capable stream-frame support for that connection
- the existing shared-secret challenge-response flow is the transition credential for gRPC control
- authenticated gRPC sessions register `transport_session.transport_kind = "h2_grpc"`
- terminal lifecycle/control frames may route over gRPC through the same transport router; bulk proxy/file/data migration remains later-phase work

Phase 3 HTTP/2 data fallback is opt-in during rollout:

- service starts the grpc-js data listener only when `GRPC_DATA_ENABLED=true`
- default listener address is `127.0.0.1:50052`
- daemon attaches only when `BUD_GRPC_DATA_URL` is set
- data streams must attach after successful gRPC control authentication
- the first data-stream frame must be `data_attach`
- the service binds `data_attach.bud_id` and `data_attach.device_session_id` to the active authenticated control tracker
- authenticated data streams register `transport_session.transport_kind = "h2_data"`
- the initial concrete migration sends daemon `terminal_output` over `BudData.Attach`
- terminal requests, heartbeat, reconnect reconciliation, terminal status/readiness, and terminal send/observe results remain on control
- if the daemon data channel is unavailable or full, daemon terminal output falls back to the gRPC control stream rather than being dropped
- Phase 4.2 localhost proxy streams negotiate `localhost_http_proxy`; proxy bytes use the selected data-plane carrier, which is WebSocket by default and `h2_data` when explicitly selected/configured
- Phase 4.4 file streams negotiate `file_read`; file bytes use the selected data-plane carrier, which is WebSocket by default and `h2_data` when explicitly selected/configured

### 3.1 Bud ⇄ Service WebSocket

- URL: `wss://<host>/ws`
- Encoding: protobuf `BudEnvelope` binary frames; daemon sessions require `bud_envelope.websocket_binary`
- Active terminal/control binary payloads use typed protobuf fields under their oneof payload tags, not whole-frame `frame_json`
- Core data-plane lifecycle binary payloads (`data_attach`, `data_attach_ack`, `stream_data`, `stream_credit`, `stream_reset`, `stream_close`) also use typed protobuf fields under their oneof payload tags
- Peers that also advertise `bud_envelope.stream_frames` can use the same authenticated WebSocket as a control+data carrier for `stream_data`, `stream_credit`, `stream_reset`, `stream_close`, `proxy_open_result`, and `file_open_result`
- Bud should send `heartbeat` every 30 seconds
- Service marks a Bud offline after `offlineGraceSec` with no accepted heartbeat
- Bud output chunks should stay at or below 16 KiB

### 3.1.1 Bud ⇄ Service gRPC Control

- Service: `bud.v1.BudControl.Connect`
- Encoding: protobuf `BudEnvelope`
- Runtime: grpc-js on the service, tonic/prost on the daemon
- Stream shape: bidirectional long-lived control stream
- Current payload bridge: typed oneof payloads with `frame_json` bytes containing the same JSON frame shapes documented below; field-level payloads currently apply to the active WebSocket binary carrier
- Auth: same `hello` → `hello_challenge` → `hello_proof` → `hello_ack` challenge-response as WebSocket during the transition
- Heartbeats and reconnect reconciliation use the same frame shapes as WebSocket
- Message size default: 4 MiB control envelopes, configurable with `GRPC_CONTROL_MAX_MESSAGE_BYTES`
- Deployed traffic must use TLS or an equivalent trusted HTTP/2 front-door termination path

### 3.1.2 Bud ⇄ Service gRPC Data

- Service: `bud.v1.BudData.Attach`
- Encoding: protobuf `BudEnvelope`
- Runtime: grpc-js on the service, tonic/prost on the daemon
- Stream shape: bidirectional subordinate data stream
- Current payload bridge: typed oneof payloads with `frame_json` bytes containing the same JSON frame shapes documented below; WebSocket binary envelopes use the same typed stream payload tags for the WebSocket carrier
- Auth binding: first frame is `data_attach`; service accepts it only if `bud_id` and `device_session_id` match the active authenticated gRPC control session
- Current migrated traffic: Bud → Service `terminal_output`, Phase 4.2 daemon-backed localhost proxy response bytes, and Phase 4.4 daemon-backed file stat/read/range bytes
- Current control fallback: if the daemon-side bounded data queue is closed or full, `terminal_output` is sent on `BudControl.Connect`
- Generic stream frames: `stream_data`, `stream_credit`, `stream_reset`, and `stream_close` are data-plane frames for proxy/file stream work and use the selected carrier; the baseline selected carrier is the authenticated binary WebSocket
- Localhost proxy open frames: `proxy_open` and `proxy_open_result` move over the selected carrier's control side; bytes for accepted streams move over that carrier's data side
- File open frames: `file_open` and `file_open_result` move over the selected carrier's control side; bytes for accepted read/range streams move over that carrier's data side
- Stream credits: Phase 4.0 tracks per-stream receive/send offsets and credit windows for generic streams; accepted bytes consume credit and credit is re-granted only after the receiver has consumed the bytes
- Chunk limit default: 16 KiB decoded generic stream chunks, configurable with `DATA_PLANE_MAX_CHUNK_BYTES`; gRPC terminal-output chunks keep the legacy `GRPC_DATA_MAX_CHUNK_BYTES` setting
- Generic stream limits: the service enforces per-Bud file/proxy concurrency, max in-flight credit, idle timeout, absolute stream TTL, file-session max bytes, and proxy response max bytes before forwarding bytes to the browser
- Message size default: 4 MiB data envelopes, configurable with `GRPC_DATA_MAX_MESSAGE_BYTES`
- Deployed traffic must use TLS or an equivalent trusted HTTP/2 front-door termination path

Initial attach frame:

```json
{
  "proto": "0.1",
  "type": "data_attach",
  "id": "01...",
  "ts": 1731,
  "bud_id": "b_01H...",
  "device_session_id": "s_01H...",
  "streams": ["terminal_output", "localhost_http_proxy", "file_read"],
  "max_chunk_bytes": 16384,
  "ext": {}
}
```

Successful attach reply:

```json
{
  "proto": "0.1",
  "type": "data_attach_ack",
  "id": "01...",
  "ts": 1731,
  "bud_id": "b_01H...",
  "device_session_id": "s_01H...",
  "transport_session_id": "ts_01H...",
  "streams": ["terminal_output", "localhost_http_proxy", "file_read"],
  "max_chunk_bytes": 16384,
  "initial_credit_bytes": 1048576,
  "ext": {}
}
```

Generic `stream_data`, `stream_credit`, `stream_reset`, and `stream_close` envelope payloads exist in `proto/bud/v1/bud.proto` for proxy/file work and use direct protobuf fields on the WebSocket BudEnvelope carrier. Runtime credit enforcement is now implemented for generic streams and remains separate from the terminal-output path; terminal output still uses the current bounded queue plus chunk limits. `stream_close.final_offset` must exactly equal the receiver's accepted byte count; a mismatch is a protocol error and resets the stream.

Generic stream data frame:

```json
{
  "proto": "0.1",
  "type": "stream_data",
  "id": "01...",
  "ts": 1731,
  "stream_id": "st_01H...",
  "stream_type": "localhost_http_proxy",
  "offset": 0,
  "data": "base64-bytes",
  "end_stream": false,
  "ext": {}
}
```

Generic stream credit frame:

```json
{
  "proto": "0.1",
  "type": "stream_credit",
  "id": "01...",
  "ts": 1731,
  "stream_id": "st_01H...",
  "receive_offset": 16384,
  "credit_bytes": 16384,
  "ext": {}
}
```

Generic reset/close frames:

```json
{
  "proto": "0.1",
  "type": "stream_reset",
  "id": "01...",
  "ts": 1731,
  "stream_id": "st_01H...",
  "reason": "backpressure",
  "error": {
    "code": "CREDIT_EXHAUSTED",
    "message": "stream frame exceeds available credit",
    "retryable": false
  },
  "ext": {}
}
```

```json
{
  "proto": "0.1",
  "type": "stream_close",
  "id": "01...",
  "ts": 1731,
  "stream_id": "st_01H...",
  "final_offset": 32768,
  "ext": {}
}
```

Localhost proxy open request (Service → Bud on control):

```json
{
  "proto": "0.1",
  "type": "proxy_open",
  "id": "01...",
  "ts": 1731,
  "operation_id": "op_01H...",
  "stream_id": "st_01H...",
  "proxy_session_id": "ps_01H...",
  "stream_type": "localhost_http_proxy",
  "target_host": "127.0.0.1",
  "target_port": 5173,
  "method": "GET",
  "path": "/index.html?dev=1",
  "headers": {
    "accept": "text/html"
  },
  "initial_credit_bytes": 1048576,
  "max_chunk_bytes": 16384,
  "ext": {}
}
```

Localhost proxy open result (Bud → Service on control):

```json
{
  "proto": "0.1",
  "type": "proxy_open_result",
  "id": "01...",
  "ts": 1731,
  "operation_id": "op_01H...",
  "stream_id": "st_01H...",
  "accepted": true,
  "status_code": 200,
  "headers": {
    "content-type": "text/html"
  },
  "ext": {}
}
```

Rejected proxy opens use the same frame with `accepted: false` and a typed `error` object.

File open request (Service → Bud on control):

```json
{
  "proto": "0.1",
  "type": "file_open",
  "id": "01...",
  "ts": 1731,
  "operation_id": "op_01H...",
  "stream_id": "st_01H...",
  "file_session_id": "fs_01H...",
  "stream_type": "file_read",
  "root_key": "workspace",
  "relative_path": "src/index.ts",
  "mode": "range",
  "range_start": 0,
  "range_end": 1023,
  "expected_content_identity": {
    "size": 4096,
    "modified_ms": 1777132800000
  },
  "max_bytes": 67108864,
  "initial_credit_bytes": 1048576,
  "max_chunk_bytes": 16384,
  "ext": {}
}
```

File open result (Bud → Service on control):

```json
{
  "proto": "0.1",
  "type": "file_open_result",
  "id": "01...",
  "ts": 1731,
  "operation_id": "op_01H...",
  "stream_id": "st_01H...",
  "accepted": true,
  "status_code": 206,
  "headers": {
    "accept-ranges": "bytes",
    "content-length": "1024",
    "content-range": "bytes 0-1023/4096",
    "content-type": "application/octet-stream",
    "etag": "W/\"bud-4096-1777132800000\""
  },
  "content_identity": {
    "size": 4096,
    "modified_ms": 1777132800000
  },
  "size": 4096,
  "ext": {}
}
```

Rejected file opens use the same frame with `accepted: false` and a typed `error` object. Common file error codes include `POLICY_DENIED`, `UNSUPPORTED_ROOT`, `UNSAFE_PATH`, `UNSAFE_FILE_TYPE`, `SYMLINK_DENIED`, `FILE_NOT_FOUND`, `RANGE_NOT_SATISFIABLE`, `FILE_TOO_LARGE`, `CONTENT_CHANGED`, and `LOCAL_READ_FAILED`.

### 3.2 Agent Runtime Snapshot

- URL: `GET /api/threads/:thread_id/agent/state`
- Returns the current best-effort in-flight runtime snapshot for the authorized viewer
- Snapshot includes `active`, `turn_id`, `phase`, `can_cancel`, `stream_cursor`, `pending_tool`, `draft_assistant`, and `updated_at`

### 3.3 Agent SSE Stream

- URL: `GET /api/threads/:thread_id/agent/stream`
- Authorized, thread-scoped SSE stream
- Fresh attach with no cursor is live-only
- Resume uses `after=<cursor>` primarily; `Last-Event-ID` and `last_event_id` are compatibility inputs
- SSE frame `id:` is the opaque bounded-resume cursor shared with `/agent/state.stream_cursor`

### 3.4 Terminal SSE Stream

- URL: `GET /api/threads/:thread_id/terminal/stream`
- Authorized, thread-scoped SSE stream
- Carries live terminal output/status/readiness plus Bud online/offline notices for the owning thread
- Historical backfill comes from `GET /api/threads/:thread_id/terminal/history`, not SSE replay

### 3.5 Thread Message Write

- URL: `POST /api/threads/:thread_id/messages`
- Request body:

```json
{
  "text": "string",
  "client_id": "uuidv7 optional",
  "cwd": "string optional",
  "model": "string optional",
  "reasoning_effort": "none|low|medium|high optional"
}
```

- New writes return `201 { "message_id": "...", "client_id": "..." }`
- Duplicate same-thread retries using the same authenticated `client_id` return `200` with the existing identifiers

### 3.6 Thread Read Watermark Write

- URL: `POST /api/threads/:thread_id/read`
- Request body:

```json
{
  "last_seen_message_id": "uuid"
}
```

- Advances the viewer's per-thread read watermark only if the referenced owned message is newer than the currently stored watermark
- Success response:

```json
{
  "ok": true,
  "updated": true,
  "last_seen_message_id": "uuid"
}
```

### 3.7 Notification Summary And Push Registration

- `GET /api/me/notifications/summary`
  - returns `{ "unseen_thread_count": 3, "updated_at": "..." }`
  - `unseen_thread_count` is the number of owned threads whose latest attention-worthy output is newer than the viewer's read watermark
- `PUT /api/me/push/endpoints/:installation_id`
  - creates or updates one owned push registration
- `DELETE /api/me/push/endpoints/:installation_id`
  - deletes one owned push registration

Registration request body:

```json
{
  "platform": "ios",
  "provider": "apns",
  "provider_environment": "sandbox",
  "app_id": "chat.bud.app.staging",
  "token": "<provider-device-token>",
  "enabled": true,
  "alerts_agent_completed": true,
  "alerts_human_input_requested": true,
  "include_message_preview": true
}
```

APNs registration rules:
- accepted Bud APNs topics default to `chat.bud.app` and `chat.bud.app.staging`
- unknown APNs `app_id` values return `400 { "error": "invalid_app_id", "allowed_app_ids": [...] }`
- `provider_environment: "sandbox"` and `"development"` target APNs sandbox delivery; `"production"` targets production APNs delivery
- registering the same APNs provider token or reused installation id under a different authenticated user removes stale prior endpoint ownership before the new registration is stored

### 3.8 Localhost Proxy Sessions

Phase 4.2 adds the browser-facing proxy session contract and a minimal daemon-backed GET/HEAD streaming path.

Create session:

- URL: `POST /api/buds/:bud_id/proxy-sessions`
- Authenticated viewer required
- `bud_id` must belong to the viewer
- optional `thread_id` must belong to the same viewer and Bud
- target is restricted to explicit `http://127.0.0.1:<port>`
- if no active data-plane carrier has negotiated `localhost_http_proxy`, the session records degraded state and proxy edge requests fail closed with `424`

Request body:

```json
{
  "target_host": "127.0.0.1",
  "target_port": 5173,
  "allowed_methods": ["GET", "HEAD"],
  "ttl_seconds": 900,
  "thread_id": "uuid optional",
  "display_metadata": {}
}
```

Response:

```json
{
  "proxy_session_id": "ps_01H...",
  "bud_id": "b_01H...",
  "thread_id": null,
  "operation_id": null,
  "active_stream_id": null,
  "target": {
    "host": "127.0.0.1",
    "port": 5173,
    "url": "http://127.0.0.1:5173"
  },
  "allowed_methods": ["GET", "HEAD"],
  "state": "ready",
  "proxy_url": "https://service.example/api/proxy/ps_01H.../",
  "expires_at": "2026-04-27T12:00:00.000Z",
  "revoked_at": null,
  "audit_correlation_id": "pc_01H...",
  "transport": {
    "available": true,
    "code": null,
    "message": null,
    "device_session_id": "ds_01H...",
    "control_transport_session_id": "ts_01H...",
    "data_transport_session_id": "ts_01H...",
    "transport_kind": "websocket"
  },
  "degraded": null,
  "created_at": "2026-04-27T11:45:00.000Z",
  "updated_at": "2026-04-27T11:45:00.000Z"
}
```

Additional routes:

- `GET /api/buds/:bud_id/proxy-sessions` lists owned proxy sessions for an owned Bud
- `GET /api/proxy-sessions/:proxy_session_id` reads one owned session
- `DELETE /api/proxy-sessions/:proxy_session_id` revokes one owned session
- `/api/proxy/:proxy_session_id/*` authorizes the viewer/session, enforces method/expiry/revocation/transport readiness, and streams `GET`/`HEAD` through daemon `proxy_open` plus the selected data-plane carrier
- non-GET/HEAD methods remain unsupported in Phase 4.2 and return `501 proxy_method_not_implemented`
- request and response headers are allowlisted; cookies, auth headers, hop-by-hop headers, and non-loopback targets are not forwarded

### 3.9 File Sessions

Phase 4.4 adds browser-facing file sessions and daemon-backed `HEAD`, full read, and single-range read support.

Create session:

- URL: `POST /api/buds/:bud_id/file-sessions`
- Authenticated viewer required
- `bud_id` must belong to the viewer
- optional `thread_id` must belong to the same viewer and Bud
- root is restricted to `workspace`
- `relative_path` must be POSIX-style, root-relative, non-empty, and must not contain absolute, drive-prefix, backslash, NUL, or parent-directory traversal segments
- if no active data-plane carrier has negotiated `file_read`, the session records degraded state and file edge requests fail closed with `424`

Request body:

```json
{
  "root_key": "workspace",
  "relative_path": "src/index.ts",
  "permissions": ["stat", "read", "range"],
  "max_bytes": 67108864,
  "ttl_seconds": 900,
  "thread_id": "uuid optional",
  "display_metadata": {}
}
```

Additional routes:

- `GET /api/buds/:bud_id/file-sessions` lists owned file sessions for an owned Bud
- `GET /api/file-sessions/:file_session_id` reads one owned session
- `DELETE /api/file-sessions/:file_session_id` revokes one owned session
- `HEAD /api/files/:file_session_id` authorizes `stat` and returns daemon stat headers through `file_open`
- `GET /api/files/:file_session_id` authorizes `read` and streams the file through daemon `file_open` plus the selected data-plane carrier
- `GET /api/files/:file_session_id` with a single `Range: bytes=start-end`, `bytes=start-`, or `bytes=-suffix` header authorizes `range` and returns `206` when the daemon accepts the range
- unsafe daemon paths, symlinks, non-regular files, out-of-range reads, over-limit reads, and content identity changes fail closed with typed errors

---

## 4. WebSocket Envelope

Every `/ws` frame must include:

```json
{
  "proto": "0.1",
  "type": "string",
  "id": "01HZX...ULID",
  "ts": 1731300000000,
  "ext": {}
}
```

Terminal-specific frames use the terminal protocol version:

```json
{
  "proto": "0.2",
  "type": "terminal_*",
  "id": "01HZX...ULID",
  "ts": 1731300000000,
  "ext": {}
}
```

---

## 5. Bud Identity and Authentication

Bud connects in one of three modes:

1. **Device claim**: Bud completes `/api/device-auth/*` over HTTP, then reconnects with `bud_id` and proves possession of `device_secret`
2. **Reconnect**: Bud sends `hello` with `bud_id`, then proves possession of `device_secret`
3. **Dev-only token bypass**: local automation may send `hello.token` only when it exactly matches `DEV_BUD_TOKEN_BYPASS`

### 5.1 `hello` (Bud → Service)

Dev-only token bypass example:

```json
{
  "proto": "0.1",
  "type": "hello",
  "id": "01...",
  "ts": 1731,
  "name": "raspi-4",
  "os": "linux",
  "arch": "arm64",
  "version": "0.1.0",
  "installation_id": "inst_123",
  "token": "<DEV_BUD_TOKEN_BYPASS>",
  "capabilities": {
    "max_concurrency": 1,
    "shell_default": "/bin/sh",
    "sessions": true,
    "terminal": true,
    "terminal_proto": "0.2",
    "bud_envelope": {
      "version": 1,
      "websocket_binary": true,
      "h2_grpc_control": true,
      "h2_data": true,
      "stream_frames": true
    },
    "proxy": {
      "localhost_http": true,
      "methods": ["GET", "HEAD"],
      "target_hosts": ["127.0.0.1"]
    },
    "files": {
      "workspace_read": true,
      "roots": ["workspace"],
      "permissions": ["stat", "read", "range"]
    }
  },
  "ext": {}
}
```

Reconnect example:

```json
{
  "proto": "0.1",
  "type": "hello",
  "id": "01...",
  "ts": 1731,
  "name": "workstation",
  "os": "linux",
  "arch": "x86_64",
  "version": "0.1.0",
  "installation_id": "inst_123",
  "bud_id": "b_01H...",
  "capabilities": {
    "max_concurrency": 1,
    "shell_default": "/bin/zsh",
    "sessions": true,
    "terminal": true,
    "terminal_proto": "0.2",
    "bud_envelope": {
      "version": 1,
      "websocket_binary": true,
      "h2_grpc_control": true,
      "h2_data": true,
      "stream_frames": true
    },
    "proxy": {
      "localhost_http": true,
      "methods": ["GET", "HEAD"],
      "target_hosts": ["127.0.0.1"]
    },
    "files": {
      "workspace_read": true,
      "roots": ["workspace"],
      "permissions": ["stat", "read", "range"]
    }
  },
  "ext": {}
}
```

Rules:
- `token` is only accepted for the local-only `DEV_BUD_TOKEN_BYPASS` path; database-backed legacy enrollment tokens are disabled
- `bud_id` is only present on reconnect
- `installation_id` is optional but, when present, must remain consistent for an already-known Bud
- normal first-time onboarding uses browser-mediated device claim before challenge-response reconnect

### 5.2 `hello_challenge` (Service → Bud)

```json
{
  "proto": "0.1",
  "type": "hello_challenge",
  "id": "01...",
  "ts": 1731,
  "nonce": "base64url-32bytes",
  "ext": {}
}
```

### 5.3 `hello_proof` (Bud → Service)

```json
{
  "proto": "0.1",
  "type": "hello_proof",
  "id": "01...",
  "ts": 1731,
  "bud_id": "b_01H...",
  "hmac": "base64url",
  "ext": {}
}
```

The HMAC is computed from the nonce using the persisted `device_secret`.

### 5.4 `hello_ack` (Service → Bud)

```json
{
  "proto": "0.1",
  "type": "hello_ack",
  "id": "01...",
  "ts": 1731,
  "session_id": "s_01H...",
  "bud_id": "b_01H...",
  "device_secret": "base64url-32bytes",
  "heartbeat_sec": 30,
  "ext": {}
}
```

Notes:
- `device_secret` is only sent on device claim completion or local dev-token bypass
- service registers durable sessions and active in-memory trackers before sending `hello_ack`
- service emits Bud-online notifications only after the Bud is registered and `hello_ack` has been sent

### 5.5 `heartbeat` (Bud → Service)

```json
{
  "proto": "0.1",
  "type": "heartbeat",
  "id": "01...",
  "ts": 1731,
  "ext": {}
}
```

The service only accepts heartbeats from the currently authoritative socket for that Bud.

### 5.6 `reconnect_report` (Bud → Service)

Sent by the daemon after a successful handshake so the service can reconcile durable operation and stream state:

```json
{
  "proto": "0.1",
  "type": "reconnect_report",
  "id": "01...",
  "ts": 1731,
  "bud_id": "b_01H...",
  "device_session_id": "s_01H...",
  "operations": [
    {
      "operation_id": "op_01H...",
      "state": "running",
      "operation_type": "terminal_send",
      "updated_at": "2026-04-25T18:00:00.000Z"
    }
  ],
  "streams": [
    {
      "stream_id": "st_01H...",
      "operation_id": "op_01H...",
      "stream_type": "terminal_interactive",
      "state": "open",
      "send_offset": 0,
      "receive_offset": 16384,
      "updated_at": "2026-04-25T18:00:00.000Z"
    }
  ],
  "terminal_sessions": ["bud-b_123-thread-456"],
  "local_policy_version": "local",
  "ext": {}
}
```

### 5.7 `reconciliation_decision` (Service → Bud)

Service reply to `reconnect_report`. Each reported operation/stream is returned with the service's current state, or `unknown` if the service cannot match it.

```json
{
  "proto": "0.1",
  "type": "reconciliation_decision",
  "id": "01...",
  "ts": 1731,
  "operations": [
    {
      "operation_id": "op_01H...",
      "state": "unknown",
      "operation_type": "terminal_send",
      "error": {
        "code": "UNKNOWN_OPERATION",
        "message": "daemon reported an operation not known to this service",
        "retryable": true
      }
    }
  ],
  "streams": [],
  "ext": {}
}
```

---

## 6. Terminal Protocol (Bud ⇄ Service)

The active execution contract is thread-scoped terminals. The service sends structured terminal requests; Bud responds with status/output/readiness and request-scoped results.

### 6.1 Service → Bud Terminal Requests

Supported request families:

- `terminal_ensure`: create or verify the thread terminal session
- `terminal_resize`: resize the active terminal session
- `terminal_send`: send one structured gesture
- `terminal_observe`: explicitly inspect the terminal
- `terminal_close`: close the session

`terminal_send` uses a single gesture model:

```json
{
  "proto": "0.2",
  "type": "terminal_send",
  "id": "01...",
  "ts": 1731,
  "session_id": "bud-b_123-thread-456",
  "request_id": "req_01H...",
  "text": "git status",
  "submit": true,
  "wait_for": "settled",
  "timeout_ms": 30000,
  "ext": {}
}
```

Rules:
- the request is either `text` with optional `submit`, or one semantic `key`
- canonical keys are backend-neutral names such as `ctrl+c`, `enter`, and `escape`
- `wait_for: "settled"` is the default agent path
- `terminal.observe` is the explicit inspection hatch for `delta`, `screen`, or `history`

### 6.2 `terminal_status` (Bud → Service)

```json
{
  "proto": "0.2",
  "type": "terminal_status",
  "id": "01...",
  "ts": 1731,
  "session_id": "bud-b_123-thread-456",
  "state": "creating",
  "info": {
    "pid": 12345,
    "cwd": "/Users/adam/bud",
    "cols": 120,
    "rows": 40,
    "output_log_bytes": 4096
  },
  "ext": {}
}
```

### 6.3 `terminal_output` (Bud → Service)

```json
{
  "proto": "0.2",
  "type": "terminal_output",
  "id": "01...",
  "ts": 1731,
  "session_id": "bud-b_123-thread-456",
  "seq": 42,
  "data": "base64 payload",
  "byte_offset": 16384,
  "ext": {}
}
```

Rules:
- `seq` is monotonic per session output stream
- `byte_offset` is monotonic and is the durable ordering/backfill coordinate stored by the service
- Bud output chunks should remain at or below 16 KiB
- gRPC-capable daemons send `terminal_output` on `BudData.Attach` when the data stream is attached; WebSocket and gRPC-control fallback carry the same frame shape

### 6.4 `terminal_ready` (Bud → Service)

```json
{
  "proto": "0.2",
  "type": "terminal_ready",
  "id": "01...",
  "ts": 1731,
  "session_id": "bud-b_123-thread-456",
  "assessment": {
    "ready": true,
    "confidence": 0.93,
    "trigger": "settled",
    "prompt_type": "shell",
    "hints": {
      "looks_like_prompt": true,
      "looks_like_confirmation": false,
      "looks_like_password": false,
      "looks_like_pager": false,
      "may_still_be_processing": false
    }
  },
  "ext": {}
}
```

### 6.5 `terminal_send_result` (Bud → Service)

```json
{
  "proto": "0.2",
  "type": "terminal_send_result",
  "id": "01...",
  "ts": 1731,
  "session_id": "bud-b_123-thread-456",
  "request_id": "req_01H...",
  "submitted": true,
  "delta": {
    "changed": true,
    "text": "On branch main",
    "truncated": false
  },
  "readiness": {
    "ready": true,
    "confidence": 0.84,
    "trigger": "settled"
  },
  "error": null,
  "ext": {}
}
```

### 6.6 `terminal_observe_result` (Bud → Service)

```json
{
  "proto": "0.2",
  "type": "terminal_observe_result",
  "id": "01...",
  "ts": 1731,
  "session_id": "bud-b_123-thread-456",
  "request_id": "req_01H...",
  "view": "delta",
  "output": "base64 payload",
  "output_bytes": 1024,
  "lines_captured": 18,
  "changed": true,
  "truncated": false,
  "readiness": {
    "ready": true,
    "confidence": 0.91,
    "trigger": "changed"
  },
  "error": null,
  "ext": {}
}
```

---

## 7. Browser SSE Contracts

All browser-facing streams must authorize the viewer before attaching listeners or replaying buffered data.

### 7.1 Agent Stream Events

`GET /api/threads/:thread_id/agent/stream` may emit:

- `agent.message_start`
  - `{ "turn_id": "01TURN...", "client_id": "uuidv7" }`
- `agent.message_delta`
  - `{ "turn_id": "01TURN...", "client_id": "uuidv7", "delta": "Cloning " }`
- `agent.message_done`
  - `{ "turn_id": "01TURN...", "client_id": "uuidv7", "text": "Cloning repository..." }`
- `agent.tool_call`
  - `{ "turn_id": "01TURN...", "client_id": "uuidv7", "call_id": "call_123", "name": "terminal.send", "args": { ... }, "started_at": "2026-04-21T19:00:01.000Z" }`
- `agent.tool_result`
  - includes `turn_id`, `client_id`, `call_id`, compact tool `summary`, optional truncation metadata, authoritative `started_at`, `finished_at`, `duration_ms`, and the persisted canonical `message`
- `agent.message`
  - includes `turn_id`, `client_id`, and the persisted canonical assistant `message`
- `thread.title`
  - `{ "thread_id": "uuid", "title": "Short Title", "source": "generated_first_user_message", "updated_at": "..." }`
- `agent.resync_required`
  - `{ "error": "resync_required", "provided_cursor": "01CUR..." }`
- `final`
  - `{ "turn_id": "01TURN...", "status": "succeeded|failed|canceled", "message_id"?: "uuid", "text"?: "...", "error"?: "..." }`
- `heartbeat`

Resume rules:
- no-cursor attach is live-only
- bounded replay only replays events after a known cursor
- if the cursor is too old or unknown, the route emits `agent.resync_required`
- clients recover from replay misses by refetching `/messages` and `/agent/state`

### 7.2 Terminal Stream Events

`GET /api/threads/:thread_id/terminal/stream` may emit:

- `terminal.output`
  - `{ "session_id": "bud-b_123-thread-456", "seq": 42, "data": "base64 payload", "byte_offset": 16384 }`
- `terminal.status`
  - `{ "session_id": "bud-b_123-thread-456", "state": "ready|active|idle|closed", "info"?: { ... } }`
- `terminal.ready`
  - `{ "session_id": "bud-b_123-thread-456", "assessment": { ... } }`
- `terminal.bud_offline`
  - `{ "bud_id": "b_01H...", "reason": "disconnected" }`
- `terminal.bud_online`
  - `{ "bud_id": "b_01H..." }`
- `heartbeat`

The old Bud-scoped `/api/terminals/:bud_id/stream` route is not part of the supported contract.

### 7.3 SSE Framing

Example:

```text
id: 01CUR...
event: agent.message
data: {"turn_id":"01TURN...","client_id":"uuidv7","message":{"message_id":"uuid","client_id":"uuidv7","role":"assistant","content":"...","created_at":"2026-03-22T22:10:00.000Z"}}

```

Rules:
- `id:` on the agent stream is the opaque resume cursor
- keep-alive heartbeats are valid SSE events even when no replayable data exists
- first-party clients should key optimistic user rows, draft assistant rows, and pending tool rows by `client_id`
- completed canonical tool rows may carry `started_at`, `finished_at`, and `duration_ms` under `message.metadata`
- tool `message.content` remains the model-replay payload and should not be assumed to mirror timing-only metadata fields

---

## 8. Ordering and Delivery

- Bud must preserve terminal-output order within a session
- `terminal_output.seq` and `terminal_output.byte_offset` are monotonic per session
- terminal history correctness comes from durable storage keyed by `(session_id, byte_offset)`
- agent-stream replay is intentionally bounded and process-local; transcript correctness comes from `/messages` plus `/agent/state`
- push delivery correctness comes from the durable `push_notification_outbox` plus per-thread read-watermark suppression rules rather than any in-memory stream state
- service may ignore heartbeats, closes, or timeouts from superseded Bud sockets after a reconnect replaces the active tracker

---

## 9. Error Codes

Common service/Bud codes:

- `AUTH_FAILED` — invalid dev token bypass, bad device proof, unknown Bud, or installation mismatch
- `PROTO_VERSION_MISMATCH` — invalid envelope or incompatible `proto`
- `UNSUPPORTED_PAYLOAD` — protobuf `BudEnvelope` used an unknown payload oneof field in the reserved payload range
- `BUD_BUSY` — Bud cannot accept the requested work right now
- `EXEC_FAILED` — terminal/session operation failed before completion
- `TIMEOUT` — terminal wait/observe/send operation timed out
- `CANCELED` — user or system canceled the active work
- `BUD_DISCONNECTED` — Bud disconnected during active work
- `SERVER_RESTARTED` — service restarted and lost ephemeral runtime state

HTTP auth rules:
- `401` is for unauthenticated browser requests
- `404` is for authenticated users requesting someone else’s owned resource

---

## 10. Illustrative Flows

### 10.1 Device Claim / Dev Bypass

```text
Bud                  Service
---                  -------
/api/device-auth/start ─▶ create pending flow
browser approval ──────▶ issue bud + device_secret
hello(bud_id)  ────────▶ issue nonce
hello_proof    ────────▶ verify HMAC(device_secret, nonce)
hello_ack      ◀─────── session_id
```

Local smoke/dev harnesses may use `hello(token)` only when the token equals `DEV_BUD_TOKEN_BYPASS`.

### 10.2 Reconnect

```text
Bud                  Service
---                  -------
hello(bud_id)  ─────▶ issue nonce
hello_challenge ◀────
hello_proof    ─────▶ verify HMAC(device_secret, nonce)
hello_ack      ◀──── session_id
reconnect_report ───▶ journal operation/stream summary
reconciliation_decision ◀── service current/unknown states
```

### 10.3 Terminal Send

```text
Service → Bud: terminal_send{text|key, submit?, wait_for, timeout_ms}
Bud → Service: terminal_output(seq, byte_offset, data)*
Bud → Service: terminal_send_result{submitted, delta, readiness, error}
Service → Browser SSE: terminal.output* and terminal.ready/status as applicable
```

### 10.4 Agent Resume

```text
Browser: GET /api/threads/:thread_id/agent/state
Browser: GET /api/threads/:thread_id/agent/stream?after=<stream_cursor>
Service: replay newer buffered events if cursor is known
Service: otherwise emit agent.resync_required
```

---

## 11. Security

- production onboarding must use browser-mediated device claim; database-backed legacy enrollment tokens are disabled on daemon gateways
- `DEV_BUD_TOKEN_BYPASS` is local-only and must not be configured in deployed environments
- device secrets must never be logged and should be stored with restrictive local permissions
- reconnect auth should always use challenge-response, not reusable bearer secrets on the wire
- TLS is required for deployed WebSocket traffic
- gRPC data streams must be subordinate to an authenticated gRPC control session and must be rejected if `bud_id` or `device_session_id` does not match the active control tracker
- browser SSE/REST reads must authorize ownership before any replay, attach, or data fetch
- browser proxy-session reads, revokes, and edge attaches must authorize `proxy_session.created_by_user_id` before checking or opening daemon streams
- browser file-session reads, revokes, and edge attaches must authorize `file_session.created_by_user_id` before checking or opening daemon streams
- localhost proxy sessions must deny non-`127.0.0.1` targets at the service boundary; the daemon re-checks local policy before any local HTTP side effect
- localhost proxy streams require an authenticated data-plane carrier with `localhost_http_proxy` negotiated. The default open-source baseline is binary `BudEnvelope` over WebSocket; `h2_data` and future QUIC carriers may be selected when configured.
- file read streams require an authenticated data-plane carrier with `file_read` negotiated. The default open-source baseline is binary `BudEnvelope` over WebSocket; `h2_data` and future QUIC carriers may be selected when configured.
- file sessions are limited to the daemon's `workspace` root in this phase, and the daemon re-checks path, symlink, regular-file, max-byte, and content-identity policy before sending bytes
- push endpoint registrations and unread/read watermarks are user-owned resources; normal client-directed reads and deletes are scoped to the authenticated owner
- the push registration route may additionally server-side reclaim the same provider token or reused installation id from stale prior ownership so a logged-out account cannot keep receiving notifications for a device now registered by another user

---

## 12. Changelog

- **Current**
  - WebSocket-capable terminal/control traffic now uses binary `BudEnvelope` typed payload fields instead of typed `frame_json`; active sessions reject legacy JSON after capability negotiation, while `LegacyJsonPayload` decode support remains for fixtures and conformance tests
  - WebSocket-capable core data-plane lifecycle traffic now uses typed protobuf fields for `data_attach`, `data_attach_ack`, `stream_data`, `stream_credit`, `stream_reset`, and `stream_close`
  - Explicit daemon transport policy defaults to the WebSocket baseline, with opt-in HTTP/2/QUIC preference ordering for hosted deployments
  - Daemon gRPC control attempts fall back to the WebSocket baseline when the opt-in gRPC carrier is unavailable
  - `stream_close.final_offset` mismatches now reset as protocol errors instead of closing cleanly
  - Database-backed legacy enrollment tokens are disabled on WebSocket/gRPC gateways; only device claim and local `DEV_BUD_TOKEN_BYPASS` remain
  - Unknown top-level `BudEnvelope` payload fields now fail with `UNSUPPORTED_PAYLOAD` instead of being silently treated as missing payloads
  - WebSocket-capable daemons can advertise `bud_envelope.stream_frames`; the service registers the authenticated WebSocket as a control+data carrier and dispatches generic stream lifecycle frames through the shared data-plane runtime
  - thread-scoped terminal protocol is the active execution surface
  - opt-in `BudData.Attach` carries daemon terminal output over HTTP/2 data when configured
  - Phase 4.2 localhost proxy sessions stream GET/HEAD responses through daemon `proxy_open` plus data-only generic stream frames
  - Phase 4.4 file sessions stream stat/read/range responses through daemon `file_open` plus data-only generic stream frames
  - bounded `/agent/state` + `/agent/stream` resume is the active browser runtime contract
  - legacy standalone run transport and browser `/api/runs/*` streaming are removed from the supported protocol
