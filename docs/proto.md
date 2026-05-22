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
- data-plane selection applies the configured carrier policy plus per-carrier health; unhealthy or low-score degraded preferred carriers are skipped in favor of the next eligible WebSocket/HTTP2/QUIC candidate
- file/proxy transport responses include selected-carrier health, candidate summaries, and a selection reason so operators can tell which carrier was used or skipped
- daemon terminal/run modules send outbound payloads through a transport sender wrapper instead of a raw WebSocket sender type
- shared protobuf schema lives in `proto/bud/v1/bud.proto`
- the shared schema now exposes `service BudControl { rpc Connect(stream BudEnvelope) returns (stream BudEnvelope); }` and `service BudData { rpc Attach(stream BudEnvelope) returns (stream BudEnvelope); }`
- service and daemon both encode/decode `BudEnvelope v1` binary frames for WebSocket-capable peers; active daemon sessions must advertise `bud_envelope.websocket_binary`
- WebSocket-capable peers map active terminal/control and core data-plane lifecycle payloads to typed protobuf fields instead of wrapping the whole JSON frame in `frame_json`; intentionally dynamic nested documents such as capabilities, terminal deltas, readiness, and reconnect details remain explicit JSON/bytes subfields
- service and daemon both use `BudEnvelope v1` on the gRPC control stream, with typed oneof payloads carrying transitional `frame_json`
- WebSocket-capable peers dispatch generic stream/proxy/file foundation frames through typed protobuf oneof payload tags; `data_attach`, `data_attach_ack`, `stream_data`, `stream_credit`, `stream_reset`, and `stream_close` use direct protobuf fields, while proxy/file open and WebSocket proxy payloads remain on the bounded `frame_json` bridge
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
- Phase 5 localhost WebSocket proxy sessions negotiate `localhost_websocket_proxy`; WebSocket control/message/close frames use a dedicated message-oriented proxy frame family over the authenticated binary WebSocket carrier
- Phase 4.4 file streams negotiate `file_read`; file bytes use the selected data-plane carrier, which is WebSocket by default and `h2_data` when explicitly selected/configured

### 3.1 Bud ⇄ Service WebSocket

- URL: `wss://<host>/ws`
- Encoding: protobuf `BudEnvelope` binary frames; daemon sessions require `bud_envelope.websocket_binary`
- Active terminal/control binary payloads use typed protobuf fields under their oneof payload tags, not whole-frame `frame_json`
- Core data-plane lifecycle binary payloads (`data_attach`, `data_attach_ack`, `stream_data`, `stream_credit`, `stream_reset`, `stream_close`) also use typed protobuf fields under their oneof payload tags
- Peers that also advertise `bud_envelope.stream_frames` can use the same authenticated WebSocket as a control+data carrier for `stream_data`, `stream_credit`, `stream_reset`, `stream_close`, `proxy_open_result`, `proxy_ws_*`, and `file_open_result`
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
- Localhost WebSocket proxy frames: `proxy_ws_open`, `proxy_ws_open_result`, `proxy_ws_message`, `proxy_ws_close`, and `proxy_ws_error` preserve WebSocket message boundaries over the selected WebSocket-capable carrier
- File open frames: `file_open` and `file_open_result` move over the selected carrier's control side; bytes for accepted read/range streams move over that carrier's data side
- Stream credits: Phase 4.0 tracks per-stream receive/send offsets and credit windows for generic streams; accepted bytes consume credit and credit is re-granted only after the receiver has consumed the bytes
- Chunk limit default: 16 KiB decoded generic stream chunks, configurable with `DATA_PLANE_MAX_CHUNK_BYTES`; gRPC terminal-output chunks keep the legacy `GRPC_DATA_MAX_CHUNK_BYTES` setting
- Generic stream limits: the service enforces per-Bud file/proxy concurrency, max in-flight credit, idle timeout, absolute stream TTL, file-session max bytes, and proxy response max bytes before forwarding bytes to the browser
- Carrier health: the service treats connected carriers as healthy by default, but optional adapters may mark a carrier degraded/unhealthy; carriers below the healthy threshold are not selected for new streams when another eligible candidate exists
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
  "streams": ["terminal_output", "localhost_http_proxy", "localhost_websocket_proxy", "file_read"],
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
  "streams": ["terminal_output", "localhost_http_proxy", "localhost_websocket_proxy", "file_read"],
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
    "accept": "text/html",
    "cookie": "app_session=abc",
    "content-type": "application/json"
  },
  "request_body_bytes": 27,
  "initial_credit_bytes": 1048576,
  "max_chunk_bytes": 16384,
  "ext": {}
}
```

`target_host` is loopback-only and may be `127.0.0.1`, `::1`, or exact
`localhost`. Durable product web views reuse this same daemon frame family; in
that path `proxy_session_id` may carry the durable `proxied_site_id` for
wire-compatibility while the service owns browser auth, endpoint-host routing,
and product lifecycle state. When `request_body_bytes` is greater than zero,
the service sends exactly that many upload bytes on the same `stream_id` as
generic `stream_data` frames before waiting for `proxy_open_result`; the daemon
assembles the bounded body before opening the local loopback request. Response
bytes continue to flow from daemon to service as `stream_data` frames, with
`stream_reset` canceling either direction.
The service includes a filtered `cookie` header only for durable endpoint-host
proxied-site requests; raw `/api/proxy/:proxy_session_id/*` sessions omit
cookies because they live on the Bud app/API origin. Proxy viewer cookies,
Bud app cookies, auth headers, and reserved Bud proxy cookie names are never
forwarded to the daemon or local target.

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
  "set_cookies": [
    "app_session=abc; Path=/; HttpOnly; SameSite=Lax"
  ],
  "ext": {}
}
```

Rejected proxy opens use the same frame with `accepted: false` and a typed `error` object.
Accepted opens may include `set_cookies` as a separate array because
`Set-Cookie` is multi-valued and must not be comma-joined in the ordinary
response header map. The service filters these values before browser emission:
`Domain` is stripped so local-app cookies remain endpoint-host scoped, reserved
Bud proxy cookie names/prefixes are rejected, newline-containing values are
rejected, and configured count/byte caps are applied.

Localhost WebSocket proxy open request (Service → Bud on control):

```json
{
  "proto": "0.1",
  "type": "proxy_ws_open",
  "id": "01...",
  "ts": 1731,
  "operation_id": "op_01H...",
  "ws_session_id": "st_01H...",
  "proxied_site_id": "site_01H...",
  "stream_type": "localhost_websocket_proxy",
  "target_host": "localhost",
  "target_port": 5173,
  "path": "/@vite/client",
  "protocols": [],
  "max_message_bytes": 1048576,
  "ext": {}
}
```

Bud validates `target_host` using the same loopback-only policy as HTTP proxy
opens and connects only to `ws://` local targets in this phase. `path` includes
the browser path and query. Safe `protocols` values are forwarded to the local
target as `Sec-WebSocket-Protocol`; Bud credentials, proxy viewer cookies, and
browser auth headers are not forwarded to the local WebSocket target.

Localhost WebSocket proxy open result (Bud → Service on control):

```json
{
  "proto": "0.1",
  "type": "proxy_ws_open_result",
  "id": "01...",
  "ts": 1731,
  "operation_id": "op_01H...",
  "ws_session_id": "st_01H...",
  "accepted": true,
  "selected_protocol": null,
  "ext": {}
}
```

Rejected WebSocket opens use `accepted: false` plus a typed `error` object.
After an accepted open, both peers exchange message-framed payloads:

```json
{
  "proto": "0.1",
  "type": "proxy_ws_message",
  "id": "01...",
  "ts": 1731,
  "ws_session_id": "st_01H...",
  "message_type": "text",
  "data": "{\"type\":\"connected\"}",
  "ext": {}
}
```

For `message_type: "binary"`, `data` is base64. For `message_type: "text"`,
`data` is the UTF-8 text payload. Message senders must enforce the negotiated
`max_message_bytes` ceiling before forwarding.

Close and terminal error frames:

```json
{
  "proto": "0.1",
  "type": "proxy_ws_close",
  "id": "01...",
  "ts": 1731,
  "ws_session_id": "st_01H...",
  "code": 1000,
  "reason": "normal close",
  "ext": {}
}
```

```json
{
  "proto": "0.1",
  "type": "proxy_ws_error",
  "id": "01...",
  "ts": 1731,
  "ws_session_id": "st_01H...",
  "error": {
    "code": "LOCAL_CONNECT_FAILED",
    "message": "local WebSocket connect failed",
    "retryable": true
  },
  "ext": {}
}
```

The service allocates durable operation/stream rows only after endpoint-host
auth succeeds, enforces per-site/per-Bud WebSocket connection limits, and closes
active browser sockets when the selected daemon carrier disconnects. On proxy
endpoint-host browser handshakes, the service may select the first safe
browser-requested subprotocol before the daemon local open completes; full
browser/local selected-subprotocol parity is a later hardening item.

File resolve request (Service → Bud on control):

```json
{
  "proto": "0.1",
  "type": "file_resolve",
  "id": "01...",
  "ts": 1731,
  "operation_id": "op_01H...",
  "root_key": "workspace",
  "requested_path": "/Users/adam/bud/docs/proto.md",
  "requested_path_kind": "absolute_posix",
  "max_bytes": 1048576,
  "ext": {}
}
```

File resolve result (Bud → Service on control):

```json
{
  "proto": "0.1",
  "type": "file_resolve_result",
  "id": "01...",
  "ts": 1731,
  "operation_id": "op_01H...",
  "accepted": true,
  "root_key": "workspace",
  "requested_path_kind": "absolute_posix",
  "resolved_against": "absolute_path",
  "resolved_relative_path": "docs/proto.md",
  "content_identity": {
    "size": 4096,
    "modified_ms": 1777132800000
  },
  "size": 4096,
  "ext": {}
}
```

`file_resolve` is metadata-only. The service uses it before creating a
thread-scoped file session for absolute POSIX user-clicked paths. Bud
canonicalizes the requested path, rejects symlinks, directories, non-regular
files, and paths outside the `workspace` policy root, then returns the
workspace-relative target that the service may persist. Rejected file resolves
use `accepted: false` and the same typed `error` object shape as file opens.
The service requires normal `file_read` data-plane availability before sending
the preflight so a successful open can immediately proceed to `HEAD` / `GET`.

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
  "terminal_session_id": "sess_01H...",
  "stream_type": "file_read",
  "root_key": "workspace",
  "relative_path": "src/index.ts",
  "resolution_hint": {
    "kind": "host_cwd",
    "host_cwd": "/Users/adam/bud/service",
    "source_message_id": "22222222-2222-4222-8222-222222222222"
  },
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

`expected_content_identity` is only sent for `mode: "range"` when the session has
a stored identity. Normal file-preview `stat` and full `read` requests should
open the current file contents; they do not pin to an older session identity.

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
  "resolved_against": "message_cwd",
  "resolved_relative_path": "service/src/index.ts",
  "size": 4096,
  "ext": {}
}
```

`resolution_hint` is optional and service-created; browsers do not submit cwd hints. When present with `kind: "host_cwd"`, Bud attempts the relative path against that message-time cwd first, but only if the cwd canonicalizes inside the workspace root. Hinted requests do not fall back to click-time terminal cwd; invalid or out-of-workspace hints fall back directly to the workspace root candidate.

For contextless opens, when `terminal_session_id` is present, the daemon may query that tmux pane's current directory once and try the `pane_current_path + relative_path` candidate before falling back to the daemon workspace root. Both candidates remain constrained by canonical workspace-root policy. `resolved_against` is optional metadata and currently one of `message_cwd`, `terminal_cwd`, or `workspace`; `resolved_relative_path` is the canonical workspace-relative path actually served.

Rejected file opens and resolves use the same frame-family shape with
`accepted: false` and a typed `error` object. Common file error codes include
`POLICY_DENIED`, `UNSUPPORTED_ROOT`, `UNSAFE_PATH`, `UNSAFE_FILE_TYPE`,
`SYMLINK_DENIED`, `FILE_NOT_FOUND`, `RANGE_NOT_SATISFIABLE`,
`FILE_TOO_LARGE`, `CONTENT_CHANGED`, and `LOCAL_READ_FAILED`.

### 3.2 Agent Runtime Snapshot

- URL: `GET /api/threads/:thread_id/agent/state`
- Returns the current best-effort in-flight runtime snapshot for the authorized viewer
- Snapshot includes `active`, `turn_id`, `phase`, `can_cancel`, `stream_cursor`, `pending_tool`, `draft_assistant`, and `updated_at`
- `pending_tool` includes `client_id`, `call_id`, `name`, `args`, and `started_at` while an agent tool is running
- `phase` may be `waiting_for_user` while the agent is paused on `ask_user_questions`
- For terminal tools, `pending_tool.args.wait_for` is the effective wait mode the service will use, including implicit defaults (`terminal.send` → `"settled"`, `terminal.observe` → `"none"`)
- For web-view tools, `pending_tool.args` contains only product fields such as
  `target_port`, `path`, `title`, `proxied_site_id`, and `disable`; viewer
  grants, cookies, and daemon stream identifiers are never exposed to the model
  or clients through pending-tool state
- For `ask_user_questions`, `pending_tool.args` is the normalized
  `ask_user_questions_request_v1` payload, including `request_id`, optional
  title/body labels, and skippable question definitions

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

### 3.4.1 Terminal Interrupt

- URL: `POST /api/threads/:thread_id/terminal/interrupt`
- Authorized, thread-scoped human interrupt endpoint
- Sends `ctrl+c` through the normal `terminal_send` request path with `key: "ctrl+c"` and `wait_for: "none"`
- Rejects older pending send/observe waits for the same terminal session as `interrupted`, excluding the newly-created Ctrl+C request
- Missing active terminal session returns `404 { "error": "no_terminal_session" }`

Successful response:

```json
{
  "ok": true,
  "session_id": "bud-b_123-thread-456",
  "submitted": true,
  "rejected_pending_requests": 1
}
```

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

### 3.6.1 Agent Question Response Write

- URL: `POST /api/threads/:thread_id/agent/question-requests/:request_id/responses`
- Authorized, thread-scoped response endpoint for pending `ask_user_questions`
  tool calls
- The service validates answers against the stored request row, not client-sent
  labels or question definitions
- `client_response_id` is an idempotency key for browser retry after a network
  failure

Request body:

```json
{
  "schema": "ask_user_questions_response_v1",
  "client_response_id": "018f4f2a-0000-7000-9000-000000000000",
  "answers": [
    {
      "question_id": "target_environment",
      "status": "answered",
      "answer": { "kind": "single_choice", "choice_id": "staging" }
    },
    {
      "question_id": "rollback_window",
      "status": "skipped"
    }
  ]
}
```

Successful response:

```json
{
  "ok": true,
  "question_request_id": "qr_01J...",
  "status": "answered",
  "continuation": "live_tool_result",
  "client_id": "018f4f2a-1111-7000-9000-000000000000"
}
```

`continuation` is one of:
- `live_tool_result`: the original in-process agent tool call resumed
- `fallback_user_message`: no live waiter existed, so the service persisted a
  self-contained Q/A user message and started a normal follow-up turn
- `already_answered`: the same accepted `client_response_id` was retried

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
Phase 4a expands that path to common mutation methods plus bounded request
bodies and browser-disconnect cancellation.

Create session:

- URL: `POST /api/buds/:bud_id/proxy-sessions`
- Authenticated viewer required
- `bud_id` must belong to the viewer
- optional `thread_id` must belong to the same viewer and Bud
- target is restricted to loopback hosts: `localhost`, `127.0.0.1`, or `::1`
- if no active data-plane carrier has negotiated `localhost_http_proxy`, the session records degraded state and proxy edge requests fail closed with `424`

Request body:

```json
{
  "target_host": "localhost",
  "target_port": 5173,
  "allowed_methods": ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
  "allowed_methods": ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
    "transport_kind": "websocket",
    "health": {
      "status": "healthy",
      "score": 100,
      "reason": null,
      "checked_at": null
    },
    "selection_reason": "selected websocket with healthy(100)",
    "candidate_transports": [
      {
        "transport_kind": "websocket",
        "role": "control_data",
        "health": {
          "status": "healthy",
          "score": 100,
          "reason": null,
          "checked_at": null
        },
        "available": true,
        "reason": null
      }
    ]
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
- `/api/proxy/:proxy_session_id/*` authorizes the viewer/session, enforces method/expiry/revocation/transport readiness, and streams through daemon `proxy_open` plus the selected data-plane carrier
- allowed methods are `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`; `CONNECT`, `TRACE`, and unknown methods remain unsupported
- request bodies are buffered at the service under `PROXY_SESSION_MAX_REQUEST_BODY_BYTES`, forwarded as same-stream `stream_data`, and rejected with `413` when too large
- browser disconnects send `stream_reset` so daemon local work can stop instead of continuing in the background
- request and response headers are allowlisted; raw `/api/proxy` sessions do not forward cookies, auth headers, hop-by-hop headers, or non-loopback targets

### 3.8.1 Durable Proxied Sites And Thread Web Views

Product web views are modeled as long-lived Bud-owned `proxied_site` resources,
not as short-lived thread preview sessions. A thread may attach one current web
view, and multiple threads can attach to the same proxied site.

Product routes:

- `POST /api/buds/:bud_id/proxied-sites` creates or reuses an owned proxied site
- `GET /api/buds/:bud_id/proxied-sites` lists owned proxied sites for an owned Bud
- `GET /api/proxied-sites/:proxied_site_id` reads one owned proxied site
- `PATCH /api/proxied-sites/:proxied_site_id` updates display name, default path, or enabled state
- `DELETE /api/proxied-sites/:proxied_site_id` disables one owned proxied site
- `GET /api/threads/:thread_id/web-view` reads the thread's current attachment
- `POST /api/threads/:thread_id/web-view/attach` attaches an owned proxied site to the authorized thread
- `DELETE /api/threads/:thread_id/web-view` detaches without disabling the site
- `POST /api/proxied-sites/:proxied_site_id/viewer-grants` mints a short-lived one-time bootstrap URL

Create request:

```json
{
  "target_host": "localhost",
  "target_port": 5173,
  "path": "/",
  "title": "Vite app",
  "reuse_existing": true
}
```

`target_host` is optional for product proxied sites. When omitted, the service
defaults to exact `localhost`; callers should preserve an explicit user-provided
`localhost`, `127.0.0.1`, or `::1` host rather than substituting between them.

Proxied site response:

```json
{
  "proxied_site_id": "site_01H...",
  "bud_id": "b_01H...",
  "display_name": "Vite app",
  "slug": "vite-app-abc123",
  "endpoint_host": "vite-app-abc123.bud.show",
  "view_url": "https://vite-app-abc123.bud.show/",
  "target_host": "localhost",
  "target_port": 5173,
  "path": "/",
  "access_policy": "private_owner",
  "enabled": true,
  "state": "ready",
  "expires_at": "2026-07-26T12:00:00.000Z",
  "transport": { "available": true },
  "created_at": "2026-04-27T12:00:00.000Z",
  "updated_at": "2026-04-27T12:00:00.000Z"
}
```

Private endpoint-host gateway:

- configured wildcard hosts such as `*.bud.show` route to the service gateway
- local development can use `*.proxy.localhost`
- `/__bud/bootstrap?grant=<token>&to=<path>` consumes a one-time grant, sets a
  host-only viewer cookie, and redirects to the requested path on the endpoint
  host
- viewer cookies use a 7-day max age and a roughly 1-day refresh/update window
  when backed by a still-valid Better Auth session
- gateway traffic resolves endpoint host to `proxied_site`, validates
  enabled/expiry state, validates the endpoint-host viewer cookie, checks
  transport readiness, and only then opens daemon `proxy_open`
- HTTP gateway traffic supports `GET`, `HEAD`, `POST`, `PUT`, `PATCH`,
  `DELETE`, and `OPTIONS`; bounded request bodies are forwarded to the daemon,
  endpoint-host local-app cookies are filtered and forwarded, local-app
  `Set-Cookie` headers are filtered before browser emission, and redirect
  rewriting remains a follow-up phase
- WebSocket gateway upgrades are owner-private and require the same endpoint-host
  viewer cookie before daemon work allocation; accepted upgrades bridge
  browser text/binary messages to daemon `proxy_ws_*` frames
- product routes and thread attachments use authenticated `bud.dev` browser
  auth; iframe/subresource access uses the endpoint-host viewer cookie because
  arbitrary bearer headers are not available for normal browser navigation

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

Thread file-viewer open:

- URL: `POST /api/threads/:thread_id/files/open`
- Authenticated viewer required
- `thread_id` must belong to the viewer; signed-in non-owners receive `404`
- the service derives `bud_id` from the owned thread and ignores any client-supplied Bud identity
- accepts workspace-relative path strings and daemon-preflighted absolute POSIX path strings when the Bud advertises `files.resolve.absolute_posix`
- `path` may include `:line`, `:line:column`, or `#Lline` / `#Lline-Lend` metadata
- created sessions use `root_key: "workspace"`, permissions `["stat", "read", "range"]`, the default short TTL, and `max_bytes: 1048576`
- source metadata is display/audit metadata only; opening a file remains user-initiated and does not grant the agent file-read authority
- absolute POSIX opens call daemon `file_resolve` before session creation; accepted results are stored as normal workspace-relative file sessions with `display_metadata.requested_path_kind = "absolute_posix"` and `display_metadata.resolved_against = "absolute_path"`
- when `source.message_id` belongs to the same authorized thread and that message has server-stamped `metadata.path_context`, the service copies that context into the file session and sends a daemon `resolution_hint`
- context-bearing reads prefer message-time cwd, then workspace root; they do not fall back to click-time terminal cwd
- contextless or pre-rollout reads include the active thread terminal session id when one exists, allowing the daemon to resolve relative links against the tmux pane cwd first and workspace root second

Request body:

```json
{
  "path": "./service/src/files/file-session.ts:42:7",
  "source": {
    "kind": "assistant_message",
    "message_id": "22222222-2222-4222-8222-222222222222",
    "client_id": "33333333-3333-4333-8333-333333333333"
  },
  "viewer_intent": "preview"
}
```

Response:

```json
{
  "file_session": {
    "file_session_id": "fs_01H...",
    "bud_id": "b_01H...",
    "thread_id": "11111111-1111-4111-8111-111111111111",
    "root": { "key": "workspace" },
    "path": {
      "raw_path": "./service/src/files/file-session.ts:42:7",
      "relative_path": "service/src/files/file-session.ts"
    },
    "permissions": ["stat", "read", "range"],
    "state": "ready",
    "file_url": "https://service.example/api/files/fs_01H...",
    "max_bytes": 1048576,
    "expires_at": "2026-05-01T20:15:00.000Z",
    "display_metadata": {
      "raw_path": "./service/src/files/file-session.ts:42:7",
      "line": 42,
      "column": 7,
      "viewer_intent": "preview"
    }
  },
  "viewer": {
    "suggested_kind": "code",
    "language": "typescript",
    "display_name": "file-session.ts",
    "line": 42,
    "column": 7,
    "max_display_bytes": 1048576
  }
}
```

Additional routes:

- `GET /api/buds/:bud_id/file-sessions` lists owned file sessions for an owned Bud
- `GET /api/file-sessions/:file_session_id` reads one owned session
- `DELETE /api/file-sessions/:file_session_id` revokes one owned session
- `HEAD /api/files/:file_session_id` authorizes `stat` and returns daemon stat headers through `file_open`
- `GET /api/files/:file_session_id` authorizes `read` and streams the file through daemon `file_open` plus the selected data-plane carrier
- `GET /api/files/:file_session_id` with a single `Range: bytes=start-end`, `bytes=start-`, or `bytes=-suffix` header authorizes `range` and returns `206` when the daemon accepts the range
- unsafe daemon paths, symlinks, non-regular files, out-of-range reads, over-limit reads, stale byte-range content identity, and during-read content identity changes fail closed with typed errors

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
      "localhost_websocket": true,
      "methods": ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      "default_target_host": "localhost",
      "target_hosts": ["localhost", "127.0.0.1", "::1"]
    },
    "files": {
      "workspace_read": true,
      "roots": ["workspace"],
      "permissions": ["stat", "read", "range"],
      "resolve": {
        "absolute_posix": true
      }
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
      "localhost_websocket": true,
      "methods": ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      "default_target_host": "localhost",
      "target_hosts": ["localhost", "127.0.0.1", "::1"]
    },
    "files": {
      "workspace_read": true,
      "roots": ["workspace"],
      "permissions": ["stat", "read", "range"],
      "resolve": {
        "absolute_posix": true
      }
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
  "timeout_ms": 3600000,
  "ext": {}
}
```

Rules:
- the request is either `text` with optional `submit`, or one semantic `key`
- canonical keys are backend-neutral names such as `ctrl+c`, `enter`, and `escape`
- canonical model-facing wait modes are `settled`, `changed`, and `none`
- `wait_for: "settled"` is the default agent path and uses a service-owned one-hour timeout budget
- `wait_for: "changed"` waits for quick visible change evidence; `wait_for: "none"` is the explicit fast path for deliberate send-and-follow or no-immediate-output workflows
- `screen_stable` remains a legacy wire alias for `settled` during rollout but is not canonical or advertised to the model
- `shell_ready` remains compatibility-only where implemented, is not advertised to the model, and `terminal_observe` rejects `view: "delta"` with `wait_for: "shell_ready"`
- non-settled wait modes keep shorter service defaults unless a trusted lower-level caller supplies an explicit timeout
- the model-facing agent schema does not expose `timeout_ms`; the service owns timeout policy and keeps `timeout_ms` on the Bud wire only
- settled `terminal_send` waits begin output-quiescence/readiness assessment after dispatch plus a short guard delay, while the returned delta still compares the pre-send capture to the final capture so command echo can remain visible
- `terminal.observe` is the explicit inspection hatch for `delta`, `screen`, or `history`
- `terminal_observe` with `wait_for: "settled"` uses the same one-hour timeout budget as default `terminal_send`
- weak settled captures do not become high-confidence ready solely because output is quiet; prompt, confirmation, password, and pager evidence can still produce high-confidence readiness

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
  "host_cwd": "/Users/adam/bud/service",
  "ext": {}
}
```

If a human interrupt rejects an older pending send wait, the service records a conservative tool result for the agent with `error: "interrupted"` and `readiness.trigger: "error"`. This is not a Bud wire-frame change; it is the service-side result shape used when the pending request promise is rejected before a matching `terminal_send_result` arrives.

`host_cwd` is optional and reports the daemon-observed tmux pane cwd at result time. The service caches it on the terminal session before resolving pending terminal tool promises, then stamps message metadata with a `terminal_cwd_v1` path context for future file-link opens.

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
  "host_cwd": "/Users/adam/bud/service",
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
  - For terminal tools, `args.wait_for` is the effective wait mode exposed to web/native clients; ordinary `terminal.send` calls include `"settled"` even when the model omitted `wait_for`, and default `terminal.observe` calls include `"none"`
  - For web-view tools, `args` contains product fields only; examples include
    `target_host`, `target_port`, `path`, `title`, `proxied_site_id`, and
    `disable`. When `web_view.open` omits `target_host`, the service defaults
    the proxied site to `localhost`.
  - For `ask_user_questions`, `name` is `"ask_user_questions"` and `args` is a
    normalized request:

```json
{
  "schema": "ask_user_questions_request_v1",
  "request_id": "qr_01J...",
  "title": "Deployment details",
  "body": "A few details are needed before I continue.",
  "submit_label": "Send answers",
  "skip_all_label": "Skip all",
  "questions": [
    {
      "id": "target_environment",
      "kind": "single_choice",
      "label": "Which environment should I target?",
      "skippable": true,
      "choices": [
        { "id": "staging", "label": "Staging" },
        { "id": "production", "label": "Production" }
      ]
    }
  ]
}
```

- `agent.tool_result`
  - includes `turn_id`, `client_id`, `call_id`, compact tool `summary`, optional truncation metadata, authoritative `started_at`, `finished_at`, `duration_ms`, and the persisted canonical `message`
  - terminal tool messages may carry `message.metadata.path_context_before` and `message.metadata.path_context_after` when the service has cached daemon cwd context
  - web-view tool results include a `web_view` payload with owned proxied-site
    and thread-attachment state instead of terminal `output`/`readiness`
  - `ask_user_questions` tool results include a compact live `user_questions`
    payload with `kind: "user_questions"`, `requestId`, and per-question
    answered/skipped responses. The persisted canonical tool row is still
    carried in `message`; historical clients should parse `message.content` as
    JSON and read `result.schema: "ask_user_questions_tool_result_v1"` for the
    full Q/A result and `summary_markdown`.
- `agent.message`
  - includes `turn_id`, `client_id`, `message_id`, `text`, and the persisted canonical assistant `message`
  - may represent an intermediate visible assistant text segment before later tool calls; `message.metadata.segment_kind` is `intermediate` for those rows and `final` for final assistant rows
  - assistant and user messages may carry `message.metadata.path_context` with `schema: "terminal_cwd_v1"`; file-open routes use this server-side metadata when creating a file session from a clicked message link
- `thread.title`
  - `{ "thread_id": "uuid", "title": "Short Title", "source": "generated_first_user_message", "updated_at": "..." }`
- `agent.resync_required`
  - `{ "error": "resync_required", "provided_cursor": "01CUR..." }`
- `final`
  - `{ "turn_id": "01TURN...", "status": "succeeded|failed|canceled", "message_id"?: "uuid", "text"?: "...", "reason"?: "superseded_by_user_message", "error"?: "..." }`
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
- first-party clients must not remove a visible assistant draft just because an `agent.tool_call` arrives; text before or between tool calls is persisted as an assistant `agent.message`
- first-party clients should use `agent.tool_call.args.wait_for` or `/agent/state.pending_tool.args.wait_for` to detect settled terminal waits instead of inferring long-running terminal progress from elapsed time
- first-party clients should render `ask_user_questions` prompts from either a live `agent.tool_call` or `/agent/state.pending_tool` after refresh, and submit answers through the thread-scoped response route
- first-party clients should treat `/agent/state.phase: "waiting_for_user"` as paused human input rather than background loading, and may send normal follow-up messages through `/api/threads/:thread_id/messages`
- normal follow-up messages while `ask_user_questions` is pending are service-owned supersession: the service stores skipped answers for pending prompts, emits a completed tool row when possible, and may emit successful `final` without `message_id` or `text`
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

### 10.3.1 Human Terminal Interrupt

```text
Browser → Service: POST /api/threads/:thread_id/terminal/interrupt
Service → Bud: terminal_send{key:"ctrl+c", wait_for:"none"}
Service: reject older pending send/observe waits for the session as "interrupted"
Service → Browser SSE: agent.tool_result with conservative interrupted result when an agent tool was pending
```

### 10.4 Agent Resume

```text
Browser: GET /api/threads/:thread_id/agent/state
Browser: GET /api/threads/:thread_id/agent/stream?after=<stream_cursor>
Service: replay newer buffered events if cursor is known
Service: otherwise emit agent.resync_required
```

### 10.5 Ask User Questions

```text
Agent model → Service: ask_user_questions{questions[]}
Service: normalize and persist agent_question_request
Service → Browser SSE: agent.tool_call{client_id:"uuidv7", name:"ask_user_questions", args:{request_id,...}}
Browser → Service: POST /api/threads/:thread_id/agent/question-requests/:request_id/responses
Service: validate answers against stored request
Service → Agent model: one ask_user_questions_tool_result_v1 payload
Service → Browser SSE: agent.tool_result with user_questions result
```

If the service no longer has the live in-memory waiter when the response is
accepted, it persists a user message containing the same self-contained Q/A
summary and starts a normal follow-up agent turn.

If the browser sends a normal follow-up message while the thread has pending
`ask_user_questions` rows, the service closes all pending prompts for that
thread as skipped before persisting the new user message. The message-create
response remains `{ "message_id": "uuid", "client_id": "uuidv7" }`. The old
waiting turn emits a skipped `agent.tool_result` when possible and then:

```json
{
  "turn_id": "01TURN...",
  "status": "succeeded",
  "reason": "superseded_by_user_message"
}
```

No assistant `message_id` or `text` is created for that old turn.

---

## 11. Security

- production onboarding must use browser-mediated device claim; database-backed legacy enrollment tokens are disabled on daemon gateways
- `DEV_BUD_TOKEN_BYPASS` is local-only and must not be configured in deployed environments
- device secrets must never be logged and should be stored with restrictive local permissions
- reconnect auth should always use challenge-response, not reusable bearer secrets on the wire
- TLS is required for deployed WebSocket traffic
- gRPC data streams must be subordinate to an authenticated gRPC control session and must be rejected if `bud_id` or `device_session_id` does not match the active control tracker
- browser SSE/REST reads must authorize ownership before any replay, attach, or data fetch
- browser `ask_user_questions` response writes must authorize the thread before
  loading the question request row, and request ids belonging to another thread
  or owner return `404`
- browser proxy-session reads, revokes, and edge attaches must authorize `proxy_session.created_by_user_id` before checking or opening daemon streams
- browser proxied-site reads/mutations must authorize `proxied_site.created_by_user_id`; thread web-view attachment must authorize the thread first, derive the Bud from that thread, and then verify the proxied site belongs to the same owner and Bud
- proxy-domain gateway requests must validate the endpoint-host viewer cookie
  before opening daemon operation/stream rows; `bud.dev` cookies, auth headers,
  and Bud credentials must not be forwarded to local apps
- endpoint-host local-app cookies may be forwarded only after stripping proxy
  viewer and reserved Bud proxy cookie names; local-app `Set-Cookie` values
  must be host-only on the endpoint host and cannot overwrite reserved gateway
  auth cookie names
- browser file-session reads, revokes, and edge attaches must authorize `file_session.created_by_user_id` before checking or opening daemon streams
- thread file-viewer opens must authorize the owning thread before creating `file_session` rows, derive the Bud from that thread, and stamp `file_session.created_by_user_id` with the acting viewer
- localhost proxy sessions must deny non-loopback targets at the service boundary; product proxied sites allow only `127.0.0.1`, `::1`, or exact `localhost`, and the daemon re-checks local policy plus `localhost` loopback resolution before any local HTTP side effect
- localhost proxy streams require an authenticated data-plane carrier with `localhost_http_proxy` negotiated. The default open-source baseline is binary `BudEnvelope` over WebSocket; `h2_data` and future QUIC carriers may be selected when configured.
- localhost WebSocket proxy sessions require an authenticated WebSocket-capable carrier with `localhost_websocket_proxy` negotiated. Endpoint-host viewer auth, site state, and connection limits are enforced before daemon WebSocket open allocation.
- file read streams require an authenticated data-plane carrier with `file_read` negotiated. The default open-source baseline is binary `BudEnvelope` over WebSocket; `h2_data` and future QUIC carriers may be selected when configured.
- file sessions are limited to the daemon's `workspace` root in this phase, and the daemon re-checks path, symlink, regular-file, max-byte, range content-identity, and during-read identity policy before sending bytes
- future QUIC data sessions must attach with a short-lived token bound to the active authenticated Bud, device session, control transport session, allowed endpoint candidates, and allowed stream families; token issuance/attach is not part of the active WebSocket/HTTP2 protocol yet
- push endpoint registrations and unread/read watermarks are user-owned resources; normal client-directed reads and deletes are scoped to the authenticated owner
- the push registration route may additionally server-side reclaim the same provider token or reused installation id from stale prior ownership so a logged-out account cannot keep receiving notifications for a device now registered by another user

---

## 12. Changelog

- **Current**
  - WebSocket-capable terminal/control traffic now uses binary `BudEnvelope` typed payload fields instead of typed `frame_json`; active sessions reject legacy JSON after capability negotiation, while `LegacyJsonPayload` decode support remains for fixtures and conformance tests
  - WebSocket-capable core data-plane lifecycle traffic now uses typed protobuf fields for `data_attach`, `data_attach_ack`, `stream_data`, `stream_credit`, `stream_reset`, and `stream_close`
  - Explicit daemon transport policy defaults to the WebSocket baseline, with opt-in HTTP/2/QUIC preference ordering for hosted deployments
  - Data-plane carrier selection now includes health scores and selected/skipped carrier reasons; unhealthy or low-score degraded optional carriers are demoted without changing file/proxy product contracts
  - Daemon gRPC control attempts fall back to the WebSocket baseline when the opt-in gRPC carrier is unavailable
  - `stream_close.final_offset` mismatches now reset as protocol errors instead of closing cleanly
  - Database-backed legacy enrollment tokens are disabled on WebSocket/gRPC gateways; only device claim and local `DEV_BUD_TOKEN_BYPASS` remain
  - Unknown top-level `BudEnvelope` payload fields now fail with `UNSUPPORTED_PAYLOAD` instead of being silently treated as missing payloads
  - WebSocket-capable daemons can advertise `bud_envelope.stream_frames`; the service registers the authenticated WebSocket as a control+data carrier and dispatches generic stream lifecycle frames through the shared data-plane runtime
  - thread-scoped terminal protocol is the active execution surface
  - opt-in `BudData.Attach` carries daemon terminal output over HTTP/2 data when configured
  - Phase 4.2 localhost proxy sessions stream GET/HEAD responses through daemon `proxy_open` plus data-only generic stream frames
  - Phase 4a expands localhost HTTP proxying to common mutation methods,
    bounded request bodies over same-stream `stream_data`, loopback
    `localhost` defaults, and browser-disconnect cancellation
  - Phase 4b adds endpoint-host local-app cookie forwarding for durable
    proxied sites plus `proxy_open_result.set_cookies` filtering so app cookies
    remain host-only and cannot overwrite reserved proxy viewer cookies
  - Durable owner-private proxied sites and thread web-view attachments now use
    endpoint-host gateway routing plus cookie-backed private viewer bootstrap
    for Web and mobile clients
  - Phase 5 WebSocket proxying adds the `localhost_websocket_proxy` carrier
    family plus `proxy_ws_open`, `proxy_ws_open_result`, `proxy_ws_message`,
    `proxy_ws_close`, and `proxy_ws_error` frames for Vite/HMR-style local-dev
    WebSocket traffic
  - Phase 4.4 file sessions stream stat/read/range responses through daemon `file_open` plus data-only generic stream frames
  - thread-scoped file-viewer opens create 1 MiB file sessions from explicit user clicks in assistant messages, including daemon-preflighted absolute POSIX paths when Bud advertises `files.resolve.absolute_posix`
  - bounded `/agent/state` + `/agent/stream` resume is the active browser runtime contract
  - `agent.message` may persist intermediate assistant text before later tool calls, and clients keep streamed draft text visible when tool calls arrive
  - browser-facing `agent.tool_call.args` and `/agent/state.pending_tool.args` now expose the effective terminal `wait_for` mode, including implicit `terminal_send` settled waits
  - model-facing `ask_user_questions` lets the agent pause for structured user input; `/agent/state.phase` may be `waiting_for_user`, clients submit `ask_user_questions_response_v1` through the thread-scoped response route, and completed tool rows include a self-contained Q/A result
  - normal follow-up messages while `ask_user_questions` is pending now close pending prompts as skipped server-side, finish the old waiting turn with `reason: "superseded_by_user_message"`, and keep the message-create response shape unchanged
  - settled `terminal_send` and `terminal_observe(wait_for:"settled")` now use a service-owned one-hour timeout budget, while non-settled waits keep shorter defaults
  - model-facing terminal tool schemas now advertise only `wait_for` modes `settled`, `changed`, and `none`; lower layers still tolerate compatibility-only `shell_ready` and legacy `screen_stable` where implemented
  - the service owns model-facing terminal timeout policy; `timeout_ms` remains a Bud wire field but is not advertised as a normal agent tool argument
  - human terminal interrupt is thread-scoped at `POST /api/threads/:thread_id/terminal/interrupt` and sends `key:"ctrl+c"` through `terminal_send` while rejecting older pending waits as `interrupted`
  - model-facing `web_view_open`, `web_view_close`, and `web_view_list` tools
    let the agent attach/detach/list product web views without raw proxy-session
    authority
  - legacy standalone run transport and browser `/api/runs/*` streaming are removed from the supported protocol
