# Bud Networking Upgrade Spec

## Draft engineering handoff: WebSocket-only → HTTP/2 gRPC control + QUIC data fast path + WebSocket compatibility fallback

**Status:** Draft reference spec
**Audience:** Bud daemon, backend, infrastructure, frontend/mobile, and security engineering
**Primary objective:** Upgrade Bud’s daemon↔backend networking from a WebSocket-only foundation into a transport-pluggable architecture where HTTP/2 gRPC keeps devices reachable, QUIC accelerates high-volume data/proxy traffic, and WebSocket remains a compatibility fallback without becoming a divergent protocol.

---

# 1. Executive summary

Bud should evolve into a three-tier transport architecture:

```text
HTTP/2 gRPC:
  mandatory control plane
  mandatory streaming fallback
  durable reconciliation path
  source of truth for daemon reachability

QUIC:
  optional fast data plane
  preferred for localhost proxy, file serving, video range reads, and bulk transfer
  health-scored per daemon session
  never a launch blocker

WebSocket:
  compatibility fallback
  same protobuf envelopes
  no divergent command/proxy protocol
```

The guiding design principle:

> **HTTP/2 keeps Bud reachable. QUIC makes Bud fast when the network allows it. WebSocket keeps Bud usable in weird environments.**

The key architectural shift is that Bud should no longer treat “a socket” as the runtime. Bud should define a transport-independent protocol with durable command state, explicit stream lifecycle, typed errors, local capability checks, and resumable data semantics. HTTP/2, QUIC, and WebSocket should become different ways to carry the same Bud envelopes.

---

# 2. Decision summary

## 2.1 Recommended target architecture

```text
Web / Mobile Apps
  ├── HTTP API: commands, sessions, device config
  └── SSE: user-facing status/event streaming

Bud Backend
  ├── API service
  ├── command store
  ├── device/session registry
  ├── control gateway: HTTP/2 gRPC
  ├── data gateway: QUIC preferred, HTTP/2 fallback, WebSocket fallback
  ├── proxy edge: localhost webview and file-serving URLs
  └── audit / metrics / tracing

Bud Daemon
  ├── mandatory HTTP/2 gRPC control connection
  ├── optional QUIC data connection
  ├── HTTP/2 gRPC data fallback streams
  ├── WebSocket fallback transport
  ├── local policy engine
  ├── command executor
  ├── localhost proxy client
  └── file-serving adapter
```

## 2.2 Required transport behavior

```text
Control plane:
  required over HTTP/2 gRPC
  never depends on QUIC
  never depends on WebSocket unless HTTP/2 is unavailable

Data plane:
  prefer QUIC
  fall back to HTTP/2 gRPC streams
  fall back to WebSocket compatibility mode

Protocol:
  one Bud protocol
  one envelope model
  one stream lifecycle
  one error model
  one command state machine
  many transports
```

## 2.3 Why this shape

gRPC gives Bud typed service definitions, streaming RPCs, protobuf-based schemas, and standard error/status semantics. The official gRPC docs define unary, server-streaming, client-streaming, and bidirectional-streaming RPC shapes, with protobuf as the default interface-definition language. ([gRPC][1])

HTTP/2 gives the mandatory compatibility path for long-lived control and fallback data streams. HTTP/2 supports multiplexed streams and credit-based flow control at both stream and connection levels, but it also has TCP-level coupling and deprecated priority signaling, so Bud should use separate connections for traffic classes instead of relying on HTTP/2 priority alone. ([RFC Editor][2])

QUIC gives the data-plane upside Bud specifically wants: flow-controlled streams, low-latency connection establishment, and network path migration at the transport level. ([RFC Editor][3]) HTTP/3, built over QUIC, provides stream multiplexing and per-stream flow control, with reliable in-order delivery per stream. ([RFC Editor][4])

WebSocket remains useful because it is widely deployable and simple, but it is a single bidirectional framed channel layered over TCP. That makes it a reasonable compatibility carrier, not the right primary substrate for localhost proxying, range reads, parallel assets, and terminal/bulk coexistence. ([RFC Editor][5])

---

# 3. Goals

## 3.1 Product goals

Bud should support:

```text
remote command execution
agent-driven machine control
interactive terminal escape hatch
remote localhost webview access
one-off file serving from the host
large generated file viewing
video range reads / seeking
durable command reconciliation
device reconnect and resume
self-hosted backend deployments
weird network compatibility
```

## 3.2 Networking goals

Bud’s daemon↔backend networking should provide:

```text
mandatory reachability over HTTP/2 gRPC
optional QUIC acceleration
WebSocket fallback for constrained environments
transport-independent protobuf envelopes
typed RPC semantics
typed errors
stream isolation
traffic-class separation
backpressure
explicit retry/resume
health-scored transport selection
zero divergent fallback protocols
```

## 3.3 Security goals

The upgraded runtime should make it hard for any one weak point to become unconstrained machine control.

Bud should provide:

```text
device identity
daemon authentication
command authorization
local daemon policy checks
capability-scoped commands
capability-scoped proxy/file sessions
replay protection
audit logging
short-lived access tokens
explicit revocation
safe fallback behavior
```

---

# 4. Non-goals

This spec does **not** require:

```text
direct SSH
opening inbound ports on the host
mandatory Tailscale / VPN / Cloudflare Tunnel
mandatory S3/R2 duplication for file serving
a complete peer-to-peer overlay network
QUIC reachability as a launch blocker
browser/mobile direct connection to daemon
one exact protobuf schema prescribed upfront
```

This spec also does not require replacing the existing web/mobile API shape. The current model is compatible with the target design:

```text
web/mobile → backend:
  HTTP for commands
  SSE for user-facing streaming

backend ↔ daemon:
  HTTP/2 gRPC control
  QUIC preferred data
  HTTP/2 data fallback
  WebSocket compatibility fallback
```

---

# 5. System terminology

| Term                  | Meaning                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Daemon**            | Bud process installed on Mac/Linux/Raspberry Pi/VM. Opens outbound connections to Bud backend.                 |
| **Backend**           | Hosted or self-hosted Bud control plane. Owns user API, command state, routing, authz, audit.                  |
| **Control plane**     | Reachability, heartbeat, command dispatch, cancellation, policy, reconciliation. Mandatory HTTP/2 gRPC.        |
| **Data plane**        | Terminal streams, command output, localhost proxy, file reads, generated video, bulk transfer. QUIC preferred. |
| **Device session**    | A live daemon connection epoch. Distinct from persistent device identity.                                      |
| **Transport session** | One active transport path: HTTP/2 control, QUIC data, HTTP/2 data fallback, or WebSocket fallback.             |
| **Command**           | Durable user/agent request to do work on a device.                                                             |
| **Stream**            | A logical bidirectional or unidirectional flow under a command/proxy/file/terminal session.                    |
| **Envelope**          | Transport-independent Bud protocol wrapper around typed payloads.                                              |
| **Capability**        | Permission unit, for example `command.run`, `file.read`, `localhost.proxy`, `terminal.open`.                   |
| **Proxy session**     | Short-lived authorization context for exposing one localhost service or file-serving surface.                  |
| **Health score**      | Per-daemon-session score for whether QUIC should be used for data.                                             |

---

# 6. High-level architecture

## 6.1 Component diagram

```text
┌────────────────────┐
│ Web / Mobile Apps  │
│ HTTP + SSE         │
└─────────┬──────────┘
          │
          ▼
┌──────────────────────────────┐
│ Backend API Service          │
│ - authn/authz                │
│ - command creation           │
│ - proxy/file session minting │
│ - user-facing SSE            │
└─────────┬────────────────────┘
          │
          ▼
┌──────────────────────────────┐
│ Durable Command Store        │
│ - commands                   │
│ - stream state               │
│ - output offsets             │
│ - leases                     │
│ - audit refs                 │
└─────────┬────────────────────┘
          │
          ▼
┌──────────────────────────────┐
│ Device Session Registry      │
│ - device_id → control gateway│
│ - active transports          │
│ - health scores              │
│ - stream routing             │
└──────┬───────────┬───────────┘
       │           │
       ▼           ▼
┌─────────────┐ ┌────────────────┐
│ gRPC H2     │ │ QUIC Data       │
│ Control     │ │ Gateway         │
│ Gateway     │ │ optional fast   │
└──────┬──────┘ └────────┬───────┘
       │                 │
       ▼                 ▼
┌────────────────────────────────┐
│ Bud Daemon                     │
│ - control client               │
│ - data client                  │
│ - local policy                 │
│ - executor                     │
│ - localhost proxy adapter      │
│ - file adapter                 │
└────────────────────────────────┘
```

## 6.2 Backend service split

For early implementation and self-hosting, these can be one process. For hosted scale, they should be separable:

```text
api-service:
  user-facing HTTP/SSE
  authn/authz
  command/session creation

control-gateway:
  accepts daemon HTTP/2 gRPC control streams
  owns device liveness and command dispatch

data-gateway:
  accepts QUIC data sessions
  accepts HTTP/2 fallback data streams
  accepts WebSocket fallback streams

proxy-edge:
  public HTTPS frontend for localhost webview/file-serving URLs
  maps external HTTP requests to device data streams

command-store:
  durable command and stream state

registry:
  live device session routing

audit-service:
  immutable or append-only security/event log

metrics/tracing:
  transport and stream observability
```

---

# 7. Transport strategy

## 7.1 Mandatory HTTP/2 gRPC control plane

The daemon must always establish the HTTP/2 gRPC control connection first.

Control plane responsibilities:

```text
device hello
daemon authentication
version/capability negotiation
heartbeat
command offer
command accept/reject
command started/finished
cancel
policy updates
durable reconciliation
transport negotiation
QUIC health reporting
data-path fallback coordination
shutdown/drain
```

Control plane must **not** carry:

```text
large file bytes
video data
localhost webview response bodies
terminal flood output
bulk telemetry
```

Illustrative service shape:

```proto
service BudControl {
  rpc Connect(stream AgentControlEvent)
      returns (stream ServerControlDirective);
}
```

This service shape is intentionally high-level. Teams can map existing messages into the event/directive model.

## 7.2 QUIC preferred data plane

QUIC should be used where it provides obvious value:

```text
localhost webview proxy
parallel asset fetching
large generated files
video range reads
bulk transfer while terminal remains interactive
high-volume command output
future direct data optimization
```

QUIC must be optional. If UDP/QUIC is blocked, degraded, or unhealthy, Bud should continue through HTTP/2.

QUIC should be health-scored per daemon session and should not be assumed reliable just because a handshake succeeds.

## 7.3 HTTP/2 gRPC streaming fallback

HTTP/2 gRPC data streams are the required fallback when QUIC is unavailable or unhealthy.

Use HTTP/2 for:

```text
device enrollment
heartbeat
command dispatch
cancel
policy updates
durable command reconciliation
fallback terminal streaming
fallback localhost proxy
fallback file serving
fallback generated video reads
```

HTTP/2 data fallback should use separate connections or channels by traffic class:

```text
control:
  mandatory, lightweight

interactive:
  terminal input/output
  command output

bulk:
  file reads
  generated videos
  large uploads/downloads
  webview static assets

telemetry:
  logs/traces/metrics where applicable
```

Do not rely only on HTTP/2 stream priority. Use separate gRPC connections to create operational separation.

## 7.4 WebSocket compatibility fallback

WebSocket should remain as a final fallback.

Constraints:

```text
same protobuf envelopes
same command IDs
same stream IDs
same error model
same resume semantics
same authorization semantics
no divergent WebSocket-only commands
no special WebSocket-only proxy behavior
```

WebSocket fallback should be treated as degraded mode:

```text
lower concurrency
lower stream limits
smaller chunk sizes
stricter rate limits
fewer active proxy sessions
bulk transfer may be disabled or limited
```

---

# 8. Transport negotiation and fallback

## 8.1 Boot sequence

Daemon startup should follow this order:

```text
1. Load local device identity and config.
2. Establish HTTP/2 gRPC control connection.
3. Authenticate daemon.
4. Send Hello with versions, capabilities, and prior session state.
5. Reconcile durable command state.
6. Receive backend policy and transport config.
7. Probe QUIC data path.
8. If QUIC healthy, mark QUIC as preferred data path.
9. Establish HTTP/2 data fallback pool regardless.
10. Establish WebSocket fallback only if needed or configured.
```

## 8.2 Transport candidate model

Illustrative shape:

```proto
message TransportCandidate {
  string transport_id = 1;
  TransportKind kind = 2;       // H2_GRPC, QUIC, WEBSOCKET
  TrafficClass traffic_class = 3;
  string endpoint = 4;
  repeated string alpn = 5;
  uint32 priority = 6;
  map<string, string> parameters = 7;
}
```

## 8.3 Health scoring

Each daemon session should maintain independent health scores for available data paths.

Example dimensions:

```text
handshake success
handshake latency
recent RTT
recent jitter
stream open latency
stream reset rate
bytes/sec achieved
packet loss / retransmission estimate where available
idle timeout behavior
consecutive failures
time since last success
network change events
backend overload signal
daemon local resource pressure
```

Illustrative scoring:

```text
QUIC_HEALTH = 100
  - handshake_penalty
  - rtt_penalty
  - loss_penalty
  - reset_penalty
  - timeout_penalty
  - congestion_penalty
  - daemon_pressure_penalty
```

Suggested state machine:

```text
UNKNOWN
  → PROBING
  → HEALTHY
  → DEGRADED
  → UNHEALTHY
  → COOLDOWN
  → PROBING
```

## 8.4 Fallback policy

```text
Control:
  always HTTP/2 gRPC unless HTTP/2 unavailable
  WebSocket only as emergency compatibility path

Data:
  prefer QUIC when HEALTHY
  use HTTP/2 when QUIC DEGRADED or UNHEALTHY
  use WebSocket only when HTTP/2 data streaming unavailable

Active streams:
  do not migrate non-resumable streams unless failure occurs
  resumable file/video streams may restart on better transport
  terminal streams should favor continuity over opportunistic migration
  new streams should use current best transport
```

## 8.5 Hysteresis

Avoid transport flapping.

Example policy:

```text
promote to QUIC:
  score >= 80 for 30s
  at least 3 successful stream opens
  no recent fatal transport errors

demote from QUIC:
  score < 50
  or 2 consecutive stream failures
  or backend marks data gateway overloaded
  or daemon reports UDP path unavailable

cooldown:
  after demotion, wait 60–300s before probing again
  use exponential backoff with jitter
```

---

# 9. Control plane design

## 9.1 Control stream

The daemon opens a long-lived HTTP/2 gRPC bidirectional stream:

```proto
service BudControl {
  rpc Connect(stream AgentControlEvent)
      returns (stream ServerControlDirective);
}
```

The control stream is the canonical live link for:

```text
liveness
command offers
policy updates
cancellations
transport negotiation
stream-open directives
reconciliation
```

## 9.2 Control events from daemon

Illustrative event types:

```text
Hello
Heartbeat
CapabilityManifest
CommandAccepted
CommandRejected
CommandStarted
CommandProgress
CommandFinished
CommandFailed
CommandCancelled
OutputCheckpoint
PolicyAck
TransportProbeResult
DataPathHealth
StreamOpened
StreamClosed
StreamReset
ResumeState
DrainAck
Goodbye
```

## 9.3 Control directives from backend

Illustrative directive types:

```text
Welcome
AuthChallenge
PolicyUpdate
CommandOffer
CancelCommand
OpenStream
CloseStream
ResetStream
ProbeTransport
SetTransportPreference
Reconcile
Drain
Shutdown
Noop
```

## 9.4 Control plane invariants

```text
Control messages must be small.
Control messages must be bounded.
Control messages must be typed.
Control messages must be authenticated.
Control stream must never block on data-plane work.
Control stream must survive QUIC failure.
Control stream must remain active during bulk transfer.
Control stream must be drained before backend deploys when possible.
```

---

# 10. Data plane design

## 10.1 Data stream abstraction

All data transport paths should expose the same Bud stream abstraction:

```text
stream_id
parent_session_id
parent_command_id, optional
stream_type
traffic_class
priority
deadline
resume_policy
byte_offsets, where applicable
capability_scope
transport_kind
state
```

## 10.2 Stream types

Initial stream types:

```text
TERMINAL
COMMAND_STDOUT
COMMAND_STDERR
COMMAND_TRACE
LOCALHOST_HTTP_PROXY
LOCALHOST_WEBSOCKET_PROXY
FILE_READ
FILE_WRITE
VIDEO_RANGE_READ
BULK_UPLOAD
BULK_DOWNLOAD
TELEMETRY
```

Possible future stream types:

```text
RAW_TCP_PROXY
UNIX_SOCKET_PROXY
SCREEN_STREAM
AUDIO_STREAM
P2P_DIRECT_TRANSFER
```

Do not implement future raw socket types until the capability and security model can constrain them safely.

## 10.3 Stream lifecycle

```text
OFFERED
  → ACCEPTED
  → OPEN
  → HALF_CLOSED_LOCAL
  → HALF_CLOSED_REMOTE
  → CLOSED

OFFERED
  → REJECTED

OPEN
  → RESET

OPEN
  → EXPIRED

OPEN
  → TRANSPORT_LOST
  → RESUMING
  → OPEN

TRANSPORT_LOST
  → FAILED
```

## 10.4 Stream reset reasons

Illustrative reset reasons:

```text
CLIENT_CANCELLED
SERVER_CANCELLED
POLICY_DENIED
TOKEN_EXPIRED
DEVICE_OFFLINE
TRANSPORT_UNHEALTHY
BACKPRESSURE_LIMIT
RATE_LIMITED
RESOURCE_EXHAUSTED
LOCALHOST_UNREACHABLE
FILE_NOT_FOUND
FILE_CHANGED
CONTENT_HASH_MISMATCH
COMMAND_ENDED
DEADLINE_EXCEEDED
INTERNAL_ERROR
```

---

# 11. Traffic classes and priority

## 11.1 Traffic classes

| Class          | Examples                                    | Transport preference            | Notes                     |
| -------------- | ------------------------------------------- | ------------------------------- | ------------------------- |
| `CONTROL`      | heartbeat, command dispatch, cancel, policy | HTTP/2 gRPC only                | Mandatory. No bulk.       |
| `INTERACTIVE`  | terminal input/output, live command output  | QUIC preferred, HTTP/2 fallback | Latency-sensitive.        |
| `PROXY_ACTIVE` | localhost HTML/CSS/JS/API requests          | QUIC preferred, HTTP/2 fallback | Parallel streams.         |
| `BULK`         | generated videos, file reads, uploads       | QUIC preferred, HTTP/2 fallback | Throughput-sensitive.     |
| `TELEMETRY`    | logs, metrics, traces                       | HTTP/2 or WebSocket fallback    | Droppable under pressure. |

## 11.2 Operational rules

```text
CONTROL never shares a connection with BULK.
CONTROL never waits behind file/video bytes.
INTERACTIVE should not wait behind BULK.
Terminal input should have higher priority than terminal output.
Proxy HTML/API should have higher priority than static asset prefetch.
Video range reads should be resumable.
Telemetry should be shed first under load.
```

## 11.3 Recommended connection layout

```text
HTTP/2 gRPC:
  bud-control-h2:
    Connect stream only

  bud-interactive-h2:
    terminal, command output fallback

  bud-bulk-h2:
    file/video/proxy fallback

  bud-telemetry-h2:
    optional

QUIC:
  bud-data-quic:
    multiple streams by class
    internal Bud scheduler enforces priorities

WebSocket:
  bud-ws-control-compatible:
    fallback only

  bud-ws-data-compatible:
    optional separate fallback socket for data
```

---

# 12. Protocol envelope

## 12.1 Purpose

Bud should define a transport-independent envelope that wraps all protocol messages. The same envelope should work over:

```text
HTTP/2 gRPC
QUIC
WebSocket
test fixtures
local replay tools
```

This prevents fallback paths from becoming divergent protocols.

## 12.2 Illustrative envelope

Not final schema; intended to show required categories.

```proto
message BudEnvelope {
  string protocol_version = 1;

  string envelope_id = 2;
  string device_id = 3;
  string device_session_id = 4;
  string transport_session_id = 5;

  optional string command_id = 6;
  optional string stream_id = 7;
  optional string proxy_session_id = 8;

  uint64 sequence = 9;
  optional uint64 ack_sequence = 10;

  Direction direction = 11;
  TrafficClass traffic_class = 12;
  Priority priority = 13;

  Timestamp created_at = 14;
  optional Timestamp expires_at = 15;
  optional Duration deadline = 16;

  string trace_id = 17;
  string span_id = 18;

  AuthContext auth_context = 19;
  repeated Capability required_capabilities = 20;

  string payload_type = 21;
  bytes payload = 22;
  optional string payload_sha256 = 23;

  repeated Compression compression = 24;
  optional Signature signature = 25;

  map<string, string> metadata = 26;
}
```

## 12.3 Envelope invariants

```text
Every envelope has a unique envelope_id.
Every command-related message has a command_id.
Every stream-related message has a stream_id.
Every message has a protocol_version.
Every message has trace context.
Every message is bounded by max_frame_bytes.
Every message is authenticated by connection context and/or signature.
Every message is validated against local policy before side effects.
```

---

# 13. RPC service shape

The exact service names can vary. This section captures conceptual services.

## 13.1 Control service

```proto
service BudControl {
  rpc Connect(stream AgentControlEvent)
      returns (stream ServerControlDirective);
}
```

Used for:

```text
reachability
command dispatch
cancel
policy
transport negotiation
reconciliation
```

## 13.2 HTTP/2 fallback data service

```proto
service BudData {
  rpc Attach(stream AgentDataFrame)
      returns (stream ServerDataFrame);
}
```

Potential model:

```text
daemon opens attach streams
backend assigns work to available streams
daemon replenishes stream pool
backend uses attach streams for proxy/file/terminal fallback
```

This avoids waiting for a brand-new RPC for every proxy request while preserving daemon-outbound semantics.

## 13.3 QUIC data service

QUIC can use the same Bud envelope and stream model, but should not necessarily be implemented as gRPC-over-HTTP/3 if that constrains server-initiated stream behavior. The data plane can be:

```text
custom Bud-over-QUIC framed protocol
or WebTransport-like session
or HTTP/3-based tunnel
```

The decision should depend on implementation language, library maturity, deployment constraints, and how much raw control the team wants over stream scheduling.

Core requirement:

```text
same Bud stream abstraction
same authorization model
same resume model
same errors
same trace IDs
```

## 13.4 WebSocket fallback service

```text
WSS /daemon/connect
WSS /daemon/data
```

or a single WSS endpoint if infrastructure requires it.

But WebSocket must carry the same `BudEnvelope` and same stream frames. No separate JSON control protocol.

---

# 14. Durable command model

## 14.1 Durable state machine

Commands should be persisted independently of transport.

```text
CREATED
  → QUEUED
  → OFFERED_TO_DEVICE
  → ACCEPTED_BY_DEVICE
  → RUNNING
  → SUCCEEDED

CREATED
  → QUEUED
  → EXPIRED

OFFERED_TO_DEVICE
  → REJECTED_BY_DEVICE

RUNNING
  → CANCEL_REQUESTED
  → CANCELLED

RUNNING
  → FAILED

RUNNING
  → DEVICE_DISCONNECTED
  → RECONCILING
  → RUNNING | FAILED | UNKNOWN | CANCELLED
```

## 14.2 Command record

Illustrative fields:

```text
command_id
idempotency_key
device_id
target_user_id
org_id
created_by
created_at
expires_at
lease_expires_at
state
attempt_number
required_capabilities
policy_snapshot_id
input_hash
input_payload_ref
last_offered_session_id
last_accepted_session_id
daemon_instance_id
started_at
finished_at
exit_code
failure_code
failure_message
last_output_offset_stdout
last_output_offset_stderr
result_refs
audit_ref
trace_id
```

## 14.3 Execution semantics

Bud should avoid promising exactly-once semantics for arbitrary local processes. A safer target:

```text
dispatch:
  at-least-once offer to daemon under retry

execution:
  at-most-once per command_id when daemon local journal is intact

reconciliation:
  explicit UNKNOWN state when crash/disconnect makes outcome uncertain

idempotency:
  required for commands that can be retried safely
```

Daemon should maintain a local command journal:

```text
command_id
accepted_at
started_at
local_pid/process_group
working_directory
input_hash
status
last_output_offsets
finished_at
exit_code
```

On reconnect, daemon reports local journal state. Backend reconciles with command store.

## 14.4 Command leases

Backend should lease commands to a device session:

```text
lease_owner = device_session_id
lease_expires_at = now + lease_ttl
```

Daemon refreshes lease through control events. If lease expires:

```text
backend marks command as RECONCILING or DEVICE_DISCONNECTED
backend does not blindly re-execute
daemon reconnect determines final state
```

## 14.5 Command cancellation

Cancellation should be a control-plane directive:

```text
CancelCommand(command_id, reason, deadline)
```

Daemon behavior:

```text
send SIGTERM or platform equivalent
wait grace period
send SIGKILL if policy allows
mark cancelled or failed
stream final output checkpoint
report result
```

Cancellation must not depend on the health of QUIC data streams.

---

# 15. Localhost webview proxy

## 15.1 Desired UX

Mobile app should be able to open:

```text
https://<proxy-session>.bud-proxy.example/
```

and view a service that is actually running on the daemon host:

```text
http://127.0.0.1:<port>/
```

No inbound host ports. No direct mobile→daemon connection.

## 15.2 Flow

```text
1. User/app requests localhost proxy session.
2. Backend authorizes user/device/capability.
3. Backend creates short-lived proxy_session_id.
4. Backend returns HTTPS URL for WebView.
5. WebView requests URL.
6. Proxy edge validates session token.
7. Proxy edge selects data path:
     QUIC if healthy
     else HTTP/2 data fallback
     else WebSocket fallback if permitted
8. Backend opens LOCALHOST_HTTP_PROXY stream to daemon.
9. Daemon performs request to local target.
10. Daemon streams response headers/body back.
11. Proxy edge streams response to WebView.
```

## 15.3 Request mapping

External request:

```text
GET https://<session>.proxy.bud.run/path?x=1
```

Internal proxy request:

```text
target_scheme: http
target_host: 127.0.0.1
target_port: allowed_port
method: GET
path: /path?x=1
headers: sanitized_headers
body_stream: optional
```

## 15.4 HTTP features to support

Initial support:

```text
GET
HEAD
POST, if explicitly allowed by policy
request body streaming
response body streaming
status codes
response headers
Range requests
SSE from local service
WebSocket upgrade from local service, if explicitly enabled
```

Later support:

```text
HTTP trailers
multipart upload
raw TCP proxy
Unix socket proxy
LAN host proxy
```

## 15.5 Origin and cookie isolation

Use per-session subdomains where possible:

```text
https://<random-session-id>.proxy.bud.run
```

This helps isolate cookies and browser origin state between proxy sessions.

Policy recommendations:

```text
short session TTL
unpredictable session IDs
bind session to user/device
bind session to target port
bind session to allowed host
default target host = 127.0.0.1 only
optional path allowlist
strip or rewrite dangerous headers
do not forward Bud auth cookies to local service
```

## 15.6 Security restrictions

Default deny:

```text
LAN IPs
0.0.0.0 targets
metadata service IPs
private network ranges except 127.0.0.1
Unix sockets
privileged admin ports
Docker socket
Kubernetes API sockets
SSH agent sockets
arbitrary file:// URLs
```

Default allow:

```text
127.0.0.1:<explicit_port>
GET/HEAD
short-lived sessions
bounded response size
bounded request body size
```

Optional allow with explicit capability:

```text
POST
PUT/PATCH/DELETE
WebSocket upgrades
LAN IP targets
raw TCP
long-lived sessions
large responses
```

## 15.7 Failure behavior

```text
daemon offline:
  502 or user-friendly offline page

QUIC fails mid-response:
  retry through HTTP/2 only for idempotent/range-safe requests

POST body partially sent:
  do not automatically retry unless request has idempotency key

local service unavailable:
  502 with typed Bud error in diagnostic headers

session expired:
  403 or 410

policy revoked:
  immediately reset active streams
```

---

# 16. One-off file serving

## 16.1 Goal

Allow users/apps to open files that live only on the host machine without duplicating the file to S3/R2.

Examples:

```text
open a markdown file
view a generated video
download generated artifact
preview image/audio/log output
```

## 16.2 File serving session

Backend creates a short-lived file session:

```text
file_session_id
device_id
user_id
local_path or daemon-local file handle
content_type
content_disposition
allowed_methods
allowed_ranges
max_bytes
expires_at
required_capability
content_identity, optional
```

## 16.3 Content identity

For stable files, daemon should provide one or more of:

```text
sha256
size
mtime
inode/file_id where available
generation_id
```

For generated files, prefer a stable daemon-side artifact handle once the generator declares the file complete.

## 16.4 Range reads

Video and large file UX depends on range reads.

External client request:

```text
GET /file/<token>
Range: bytes=1000000-2000000
```

Backend maps to daemon:

```text
FILE_READ stream
offset = 1000000
length = 1000001
content_identity = expected hash/size/generation
```

Daemon returns:

```text
status: 206-compatible metadata
offset
data chunks
eof
content_identity
```

## 16.5 Stable vs. changing files

Bud should explicitly handle file mutation.

Options:

```text
STRICT:
  if file size/mtime/hash changes after token creation, fail with FILE_CHANGED

SNAPSHOT:
  daemon snapshots or spools file locally; more reliable but uses disk

LIVE:
  read current bytes; suitable for logs, not video seeking

GENERATED_ARTIFACT:
  only serve after command marks artifact complete
```

Default recommendation:

```text
markdown/text preview:
  LIVE or STRICT

video:
  GENERATED_ARTIFACT or STRICT

logs:
  LIVE with append semantics

downloads:
  STRICT
```

## 16.6 No persistent backend duplication

The backend should stream bytes and may buffer only as needed for relay/backpressure.

Allowed:

```text
small in-memory buffers
short-lived response buffering
temporary retry buffer for active stream
metrics about byte counts
```

Avoid by default:

```text
persistent object storage copy
long-lived backend cache
silent artifact duplication
```

Optional future feature:

```text
user-enabled cache or pin-to-cloud
```

---

# 17. Terminal and command output

## 17.1 Terminal

Terminal sessions should use `INTERACTIVE` traffic class.

Properties:

```text
low latency
small chunks
terminal input prioritized above terminal output
bounded scrollback
session TTL
explicit close
audit metadata
```

Terminal output should never block:

```text
cancel
policy update
heartbeat
command state transition
```

## 17.2 Command output

Command stdout/stderr should be modeled separately from command lifecycle.

```text
command lifecycle:
  control plane

stdout/stderr stream:
  data plane

output checkpoints:
  control plane or durable store
```

Output chunk fields:

```text
command_id
stream_id
fd/stdout/stderr
offset
data
encoding
truncated
timestamp
```

## 17.3 Output storage policy

Recommended tiers:

```text
live stream:
  data plane

recent buffer:
  daemon local ring buffer

durable output:
  backend store, bounded by policy

large output:
  host-side artifact/session, not automatically uploaded
```

---

# 18. Backpressure and resource limits

## 18.1 Transport-level backpressure

gRPC flow control applies to streaming RPCs and is intended to prevent a sender from overwhelming a receiver; the gRPC framework can wait before returning from a write call when the receiver lacks capacity. ([gRPC][6])

Bud should still implement application-level backpressure because transport flow control does not answer product-level questions like whether a user may stream a 20 GB file through the hosted backend.

## 18.2 Bud-level credit model

Every data stream should have Bud-level credits.

Illustrative model:

```text
receiver grants:
  max_bytes
  max_messages
  max_in_flight
  max_buffered_ms

sender may transmit until credit exhausted

receiver replenishes credit as data is consumed
```

## 18.3 Limits to enforce

Per device:

```text
max active commands
max active terminal sessions
max active proxy sessions
max active file sessions
max active streams
max aggregate bytes/sec
max aggregate buffered bytes
```

Per stream:

```text
max chunk size
max in-flight chunks
max idle time
max lifetime
max total bytes
max retry count
```

Per user/org:

```text
max connected devices
max live proxy sessions
max egress bytes/day
max command runtime
max concurrent bulk transfers
```

## 18.4 Overload behavior

When overloaded, degrade in this order:

```text
1. Drop or sample telemetry.
2. Pause bulk prefetch.
3. Throttle file/video streams.
4. Limit new proxy asset streams.
5. Preserve terminal input.
6. Preserve command cancel.
7. Preserve heartbeat.
8. Reject new sessions with typed RESOURCE_EXHAUSTED.
```

---

# 19. Resume semantics

## 19.1 General rule

Resume is not a transport feature. Resume is a Bud protocol feature.

Each stream type must define whether it is:

```text
not resumable
resumable by offset
resumable by sequence number
resumable by command state
resumable by client retry only
```

## 19.2 Command resume

```text
resume key:
  command_id

daemon reports:
  status
  pid/process group if running
  last stdout offset
  last stderr offset
  exit status if finished
```

Backend reconciles rather than re-executes blindly.

## 19.3 File/video resume

```text
resume key:
  file_session_id
  content_identity
  byte offset

safe retry:
  if content_identity matches

unsafe retry:
  if file changed or identity unknown
```

## 19.4 Localhost proxy resume

Most HTTP proxy requests should not be resumed at the Bud stream layer.

```text
GET/HEAD:
  client/browser may retry
  backend may retry only before local request body side effects occur

Range GET:
  resumable by byte range

POST/PUT/PATCH/DELETE:
  not automatically retried unless explicitly idempotent
```

## 19.5 Terminal resume

Terminal is partially resumable:

```text
session may reconnect
recent scrollback may be replayed
input during disconnect may be rejected or buffered by policy
do not claim exact byte-perfect delivery unless implemented
```

---

# 20. Typed errors

## 20.1 gRPC status mapping

gRPC has a standard status object with an integer code and string description, and defines well-known status codes such as `CANCELLED`, `INVALID_ARGUMENT`, `DEADLINE_EXCEEDED`, `NOT_FOUND`, `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, and `UNAVAILABLE`. ([gRPC][7])

Bud should use gRPC status for transport/RPC-level errors and a structured Bud error for product/runtime errors.

## 20.2 Bud error shape

Illustrative:

```proto
message BudError {
  string code = 1;              // e.g. "file.changed"
  string message = 2;           // human readable
  string diagnostic = 3;        // optional, maybe hidden from end user
  ErrorSeverity severity = 4;
  RetryHint retry_hint = 5;

  optional string command_id = 6;
  optional string stream_id = 7;
  optional string device_id = 8;

  repeated string missing_capabilities = 9;
  map<string, string> metadata = 10;
}
```

## 20.3 Error namespace examples

```text
auth.unauthenticated
auth.permission_denied
policy.denied
policy.capability_missing

device.offline
device.session_replaced
device.version_unsupported
device.resource_exhausted

transport.quic_unavailable
transport.h2_unavailable
transport.websocket_unavailable
transport.stream_reset
transport.deadline_exceeded

command.expired
command.cancelled
command.duplicate
command.unknown_after_reconnect
command.execution_failed

file.not_found
file.permission_denied
file.changed
file.too_large
file.range_not_satisfiable

proxy.session_expired
proxy.target_denied
proxy.localhost_unreachable
proxy.method_denied
proxy.websocket_upgrade_denied
```

---

# 21. Security model

## 21.1 Device identity

Each daemon should have a persistent device identity:

```text
device_id
device public/private keypair
enrollment metadata
owner/org binding
created_at
last_seen_at
revocation status
```

Recommended enrollment:

```text
1. User creates enrollment in web/mobile.
2. Backend issues short-lived enrollment code.
3. Daemon generates keypair locally.
4. Daemon redeems enrollment code.
5. Backend stores public key and device metadata.
6. Daemon receives device config.
```

## 21.2 Daemon authentication

Control connection should authenticate daemon identity with one of:

```text
mTLS using device certificate
signed challenge using device private key
short-lived token bound to device key
```

Avoid long-lived bearer tokens that alone grant device control.

## 21.3 Command authorization

Command authorization should happen at two layers:

```text
backend:
  user/session/org permission to request action

daemon:
  local device policy permits exact action
```

Daemon should be able to reject backend-approved commands.

## 21.4 Capability examples

```text
command.run
command.cancel
terminal.open
file.read
file.write
file.delete
file.serve
localhost.proxy
localhost.websocket
network.lan_proxy
process.kill
system.install
system.sudo
bud.update
bud.config.modify
```

## 21.5 Proxy security

Proxy sessions must be:

```text
short-lived
capability-scoped
device-scoped
user-scoped
target-scoped
revocable
audited
```

Default target should be:

```text
127.0.0.1:<explicit_port>
```

Not:

```text
arbitrary host
arbitrary LAN IP
cloud metadata IP
Docker socket
SSH agent
filesystem URL
```

## 21.6 File security

File sessions must prevent:

```text
path traversal
symlink escape, unless explicitly allowed
reading outside approved roots
serving files after policy revocation
serving changed files under stale token
unbounded reads
MIME confusion where relevant
```

File session tokens should bind:

```text
device_id
user_id
path or file handle
content identity where possible
expiry
max bytes
allowed ranges
capability
```

## 21.7 Transport security

```text
HTTP/2 gRPC:
  TLS
  ALPN h2
  daemon auth

QUIC:
  TLS-backed QUIC handshake
  authenticated session binding to control plane
  replay protection for any early data

WebSocket:
  WSS only
  same daemon auth
  no query-string long-lived tokens
  no divergent protocol
```

Avoid using QUIC 0-RTT for non-idempotent control or command effects. If 0-RTT is ever enabled, restrict it to replay-safe data-plane operations with explicit replay protection.

---

# 22. Observability

## 22.1 Required metrics

Per daemon session:

```text
control_connected
control_reconnect_count
last_heartbeat_age
active_commands
active_streams
active_proxy_sessions
active_file_sessions
current_data_transport
quic_health_score
h2_data_health_score
ws_fallback_active
```

Per transport:

```text
connect_attempts
connect_successes
connect_failures
handshake_latency_ms
rtt_ms
bytes_in
bytes_out
streams_opened
streams_failed
stream_reset_count
fallback_count
promotion_count
demotion_count
```

Per stream:

```text
stream_type
traffic_class
transport_kind
open_latency_ms
duration_ms
bytes_in
bytes_out
reset_reason
retry_count
resume_count
backpressure_wait_ms
```

Per proxy session:

```text
request_count
status_code_distribution
range_request_count
websocket_upgrade_count
target_port
bytes_in
bytes_out
duration
policy_denials
```

## 22.2 Tracing

Every user action should have trace continuity:

```text
frontend request
backend command/session creation
control directive
daemon accept/reject
data stream open
local request/process
data stream close
user-facing response/SSE event
```

Envelope should carry:

```text
trace_id
span_id
parent_span_id
command_id
stream_id
device_session_id
```

## 22.3 Logs

Logs should include enough to debug:

```text
transport transitions
stream lifecycle
policy decisions
command state changes
proxy target metadata
error codes
```

Logs should not include by default:

```text
file contents
terminal contents
secret env vars
authorization tokens
full request bodies
private command inputs unless explicitly configured
```

## 22.4 Audit log

Audit log should capture security-relevant events:

```text
device enrolled
device revoked
daemon connected
daemon disconnected
command requested
command accepted/rejected
command cancelled
terminal opened
proxy session created
file session created
policy denied
transport fallback occurred
local policy changed
```

Audit logs should be queryable by:

```text
user
device
org
command_id
proxy_session_id
file_session_id
time range
capability
```

---

# 23. Backend routing and scaling

## 23.1 Device session registry

The backend needs a live registry:

```text
device_id
device_session_id
control_gateway_instance
data_gateway_instance
current_transport_status
last_heartbeat_at
quic_health_score
active_stream_count
capability_manifest
daemon_version
```

## 23.2 Routing command directives

When user creates command:

```text
1. API writes command to durable store.
2. API checks registry for live device session.
3. If live, API notifies owning control gateway.
4. Control gateway sends CommandOffer over control stream.
5. Daemon accepts/rejects.
6. Command store updates state.
```

If device is offline:

```text
command queued or rejected based on policy
user receives durable pending/offline state
```

## 23.3 Routing proxy requests

When proxy edge receives request:

```text
1. Validate proxy session.
2. Resolve device_session_id.
3. Resolve preferred data transport.
4. If QUIC healthy, route to QUIC data gateway.
5. Else route to HTTP/2 data gateway.
6. Else use WebSocket fallback if enabled.
7. Else return typed unavailable response.
```

## 23.4 Gateway drain

Deploys should support graceful drain:

```text
1. Mark gateway draining.
2. Stop accepting new daemon sessions.
3. Tell connected daemons to reconnect after jitter.
4. Keep existing control streams until grace deadline.
5. Refuse new bulk streams.
6. Let active streams complete or reset with retry hints.
7. Close after deadline.
```

## 23.5 Self-hosted mode

For self-hosting, initial deployment can be one binary/container:

```text
bud-server:
  API
  control gateway
  data gateway
  proxy edge
  command store adapter
```

Production hosted deployment can split these services later without protocol changes.

---

# 24. QUIC data plane details

## 24.1 QUIC session binding

QUIC session should be bound to the authenticated HTTP/2 control session.

Possible flow:

```text
1. Daemon authenticates over HTTP/2 control.
2. Backend issues short-lived QUIC session token.
3. Daemon connects to QUIC endpoint.
4. Daemon proves possession of device key or session token.
5. Backend binds QUIC transport_session_id to device_session_id.
6. Control plane marks QUIC PROBING.
7. Data gateway performs health checks.
8. Control plane marks QUIC HEALTHY or UNHEALTHY.
```

## 24.2 QUIC stream use

QUIC streams should be used for:

```text
individual localhost proxy requests
parallel web assets
file byte-range reads
video byte-range reads
bulk transfers
possibly terminal streams
```

Each QUIC stream maps to a Bud `stream_id`.

```text
QUIC bidirectional stream N:
  Bud stream_id = abc
  stream_type = LOCALHOST_HTTP_PROXY
```

## 24.3 QUIC scheduler

Bud should implement its own scheduler over QUIC streams.

Priority order:

```text
1. terminal input
2. stream reset/cancel
3. active webview HTML/API
4. terminal output
5. command output
6. webview static assets
7. video range reads
8. file/bulk transfer
9. telemetry
```

## 24.4 QUIC fallback

When QUIC fails:

```text
mark transport DEGRADED or UNHEALTHY
do not close HTTP/2 control
route new data streams to HTTP/2
resume eligible streams by offset/sequence
let non-resumable streams fail with retry hints
probe QUIC later using cooldown
```

## 24.5 QUIC implementation caution

If the team uses HTTP/3 or gRPC-over-H3, confirm stream directionality and server-assigned work semantics. For Bud’s reverse tunnel, the daemon always initiates the outer connection, but the backend needs to assign work after that. A raw Bud-over-QUIC or WebTransport-like session may fit the data plane better than trying to force all data behavior into normal request/response HTTP semantics.

---

# 25. HTTP/2 gRPC fallback details

## 25.1 Control connection

Always required.

```text
small messages
strict max frame size
strict auth
strict heartbeat
no data bulk
```

## 25.2 Data fallback connection

Required when QUIC unavailable.

Two viable patterns:

### Pattern A: daemon-initiated attach stream pool

```text
daemon opens N Attach streams
backend assigns work to idle Attach stream
daemon replenishes pool
```

Pros:

```text
low request latency
fits daemon-outbound model
backend can assign work quickly
```

Cons:

```text
more stream bookkeeping
idle stream limits
```

### Pattern B: backend directive, daemon opens stream on demand

```text
backend sends OpenStream directive over control
daemon opens data RPC
backend sends request data
```

Pros:

```text
simpler resource usage
fewer idle streams
```

Cons:

```text
extra round trip
worse for webview asset waterfalls
```

Recommended:

```text
use attach pool for proxy/webview traffic
use on-demand streams for less latency-sensitive file/bulk work
```

## 25.3 Connection tuning

Tune separately by traffic class:

```text
control:
  small windows
  low max message size
  long-lived
  strict keepalive

interactive:
  low latency
  modest windows
  low buffering

bulk:
  larger windows
  larger chunks
  throughput-oriented

telemetry:
  low priority
  droppable
```

---

# 26. WebSocket fallback details

## 26.1 Compatibility contract

WebSocket fallback must pass the same tests as HTTP/2 and QUIC at the Bud protocol layer.

Required:

```text
same BudEnvelope
same command state machine
same stream state machine
same errors
same resume rules
same auth
same local policy checks
```

Not allowed:

```text
special JSON-only commands
special file-serving implementation
special proxy URL semantics
separate auth rules
different error codes
different command lifecycle
```

## 26.2 Degraded limits

Example degraded defaults:

```text
max active proxy streams: 4
max active file streams: 1
max chunk size: lower than H2/QUIC
max video preview size: policy-dependent
bulk transfer: disabled or throttled by default
terminal: allowed
control: allowed
```

## 26.3 WebSocket frame model

Carry serialized envelopes:

```text
binary WebSocket message:
  length-delimited BudEnvelope
```

If multiplexing over WebSocket is required, it must use the same Bud stream frame types as other transports.

---

# 27. Capability and policy model

## 27.1 Capability manifest from daemon

Daemon should advertise:

```text
supported protocol versions
supported transports
supported stream types
supported compression algorithms
supported auth mechanisms
supported local policy version
filesystem roots, if configured
localhost proxy policy
max stream limits
max file size policy
terminal support
command runner support
```

## 27.2 Backend policy to daemon

Backend sends policy snapshot:

```text
allowed users
allowed capabilities
org policy
proxy constraints
file constraints
command constraints
terminal constraints
audit requirements
retention config
transport config
```

## 27.3 Local policy wins

If backend and daemon disagree:

```text
most restrictive policy wins
daemon may reject
backend records rejection
user sees policy-denied state
```

---

# 28. Data schemas: illustrative message families

This section intentionally avoids locking exact names/fields. It defines the categories engineering should map into protobuf.

## 28.1 Control payloads

```text
Hello
Welcome
AuthChallenge
AuthResponse
Heartbeat
CapabilityManifest
PolicyUpdate
PolicyAck
CommandOffer
CommandAccept
CommandReject
CommandStarted
CommandFinished
CommandFailed
CancelCommand
CancelAck
ReconcileRequest
ReconcileReport
TransportProbeRequest
TransportProbeResult
DataPathHealthReport
DrainRequest
DrainAck
```

## 28.2 Stream payloads

```text
OpenStream
StreamAccepted
StreamRejected
StreamData
StreamCredit
StreamCheckpoint
StreamHalfClose
StreamClose
StreamReset
StreamResumeRequest
StreamResumeAccepted
StreamResumeRejected
```

## 28.3 Proxy payloads

```text
ProxySessionOpen
ProxySessionClose
HttpRequestHeaders
HttpRequestBodyChunk
HttpRequestEnd
HttpResponseHeaders
HttpResponseBodyChunk
HttpResponseEnd
WebSocketUpgradeRequest
WebSocketUpgradeAccepted
WebSocketFrame
```

## 28.4 File payloads

```text
FileSessionOpen
FileSessionClose
FileStatRequest
FileStatResponse
FileReadRequest
FileReadChunk
FileReadComplete
FileWriteRequest
FileWriteChunk
FileWriteComplete
FileChanged
RangeNotSatisfiable
```

## 28.5 Terminal payloads

```text
TerminalOpen
TerminalOpened
TerminalInput
TerminalOutput
TerminalResize
TerminalClose
TerminalClosed
TerminalBacklogRequest
TerminalBacklogChunk
```

---

# 29. Frontend/mobile interaction

## 29.1 Existing API can remain

The frontend/mobile architecture can remain:

```text
HTTP:
  create command
  create proxy session
  create file session
  cancel command
  fetch command status

SSE:
  command events
  device events
  stream metadata
```

No direct mobile gRPC/QUIC dependency is required.

## 29.2 Mobile WebView

Mobile opens backend HTTPS URL:

```text
https://<session>.proxy.bud.run/
```

The app does not need to know whether the backend used QUIC, HTTP/2, or WebSocket to reach the daemon.

## 29.3 User-visible degradation

When QUIC unavailable:

```text
webview still opens
file still opens
video may seek more slowly
bulk transfer may throttle
terminal remains usable
```

When only WebSocket fallback available:

```text
show degraded connectivity indicator
limit proxy sessions
possibly disable large video preview
preserve command/control
```

---

# 30. Migration plan

## Phase 0: Freeze protocol semantics

Before transport work:

```text
document command lifecycle
document stream lifecycle
document error model
document capability model
document resume model
choose protobuf envelope structure
add protocol versioning
```

## Phase 1: Protobuf envelopes over existing WebSocket

Purpose:

```text
avoid changing transport and protocol simultaneously
start removing ad-hoc JSON
establish compatibility tests
```

Deliverables:

```text
BudEnvelope v1
typed payloads for current command/control
typed errors
WebSocket binary envelope support
protocol conformance tests
```

## Phase 2: Durable command store and reconciliation

Deliverables:

```text
durable command state machine
daemon local command journal
command leases
reconnect reconciliation
idempotency keys
output offsets
explicit UNKNOWN state
```

## Phase 3: Mandatory HTTP/2 gRPC control plane

Deliverables:

```text
BudControl.Connect
daemon auth
hello/capability negotiation
heartbeat
command offer/ack
cancel
policy update
reconcile
gateway drain
```

Success criteria:

```text
commands work over HTTP/2 control
WebSocket no longer required for control where HTTP/2 works
reconnect/reconcile is less hacky
```

## Phase 4: HTTP/2 gRPC data fallback

Deliverables:

```text
BudData.Attach
stream lifecycle
terminal stream
command output stream
file read stream
localhost proxy stream
backpressure credits
typed resets
```

Success criteria:

```text
localhost proxy works over HTTP/2
file serving works over HTTP/2
terminal remains interactive during file transfer with separate channels
```

## Phase 5: QUIC data fast path

Deliverables:

```text
QUIC session token binding
QUIC data gateway
Bud-over-QUIC envelope framing
stream mapping
health scoring
promotion/demotion
HTTP/2 fallback on QUIC failure
range read over QUIC
localhost webview over QUIC
```

Success criteria:

```text
QUIC serves local webview assets in parallel
video range reads prefer QUIC
bulk transfer does not break terminal interactivity
UDP blocked environment gracefully falls back to HTTP/2
```

## Phase 6: WebSocket compatibility fallback cleanup

Deliverables:

```text
WebSocket uses same envelopes
remove divergent WebSocket-only code
document degraded limits
fallback conformance tests
```

Success criteria:

```text
WebSocket fallback passes protocol conformance
no separate command/proxy semantics
```

---

# 31. Testing plan

## 31.1 Protocol conformance

Run the same test suite against:

```text
HTTP/2 gRPC
QUIC
WebSocket
```

Test:

```text
envelope validation
version negotiation
typed errors
stream lifecycle
command lifecycle
resume semantics
policy rejection
backpressure
cancellation
```

## 31.2 Network chaos

Simulate:

```text
UDP blocked
UDP intermittent
high packet loss
high jitter
NAT rebinding
laptop sleep/wake
daemon restart
backend gateway restart
load balancer idle timeout
mobile network change
slow receiver
fast sender
mid-stream disconnect
```

## 31.3 Proxy tests

Test:

```text
parallel asset loading
large HTML/CSS/JS bundle
SSE from local service
local WebSocket upgrade
large response body
Range requests
POST body streaming
local service crash
session expiry mid-stream
policy revoke mid-stream
```

## 31.4 File tests

Test:

```text
small markdown file
large markdown file
large video
range seek
file changes during read
file deleted during read
symlink traversal attempt
path traversal attempt
permission denied
resume after disconnect
```

## 31.5 Security tests

Test:

```text
replay old command
reuse expired proxy token
reuse file token from another user
access denied port
access LAN IP by default
access metadata IP
path traversal
symlink escape
oversized messages
malformed protobuf
invalid sequence numbers
unauthorized stream open
command signed for wrong device
```

## 31.6 Performance benchmarks

Measure:

```text
command dispatch latency
heartbeat stability
terminal latency under bulk transfer
webview first byte
webview full load time
parallel asset waterfall
video seek latency
file throughput
fallback transition time
memory under slow receiver
CPU under many streams
```

---

# 32. Acceptance criteria

## 32.1 Reachability

```text
Device remains controllable when QUIC is unavailable.
Device remains controllable when WebSocket fallback is disabled.
Control plane survives data-plane failure.
Backend deploys do not orphan running commands without reconciliation.
```

## 32.2 Performance

```text
QUIC is used for localhost proxy when healthy.
QUIC is used for large/range file reads when healthy.
Terminal remains interactive during large file transfer.
Parallel webview assets do not serialize behind one stream.
Video range reads can resume after transport failure.
```

## 32.3 Protocol consistency

```text
Same Bud envelopes across HTTP/2, QUIC, and WebSocket.
Same command state machine across transports.
Same stream lifecycle across transports.
Same typed errors across transports.
Same authz/local policy checks across transports.
```

## 32.4 Safety

```text
Daemon can reject backend-approved command due to local policy.
Proxy sessions are short-lived and scoped.
File sessions are short-lived and scoped.
WebSocket fallback does not bypass security controls.
Transport fallback does not bypass capability checks.
```

---

# 33. Open engineering questions

These should be resolved during design review.

## 33.1 QUIC implementation shape

Options:

```text
custom Bud-over-QUIC
HTTP/3 tunnel
WebTransport-like session
gRPC-over-H3 where supported
```

Decision factors:

```text
library maturity in daemon/backend language
server-initiated stream support
stream scheduling control
observability
load balancer support
self-hosting complexity
fallback integration
```

## 33.2 Proxy scope

Initial proxy should likely be:

```text
HTTP to 127.0.0.1 only
explicit port
short-lived
GET/HEAD default
POST optional
WebSocket upgrade optional
```

Open question:

```text
When, if ever, should Bud support LAN IPs, raw TCP, Unix sockets, or Docker/Kubernetes sockets?
```

## 33.3 File identity

Need platform-specific decision:

```text
hash entire file upfront
use size+mtime
use inode/file ID
use generated artifact handle
use daemon snapshot
```

For large videos, hashing upfront may delay first byte. Consider policy by file type and size.

## 33.4 Backend buffering

Need decide how much proxy/file data backend may buffer:

```text
none beyond streaming buffers
small in-memory buffers
short-lived disk spool
optional user-configured cache
```

Default should avoid persistent duplication.

## 33.5 Command signing

Decide whether command envelopes are:

```text
backend-authenticated only
user/session signed
device-verifiable with local policy
end-to-end encrypted from user to daemon
```

This affects trust posture for hosted Bud.

---

# 34. Recommended first implementation slice

The most useful first slice is not QUIC. It is the protocol foundation.

Build in this order:

```text
1. BudEnvelope v1 over current WebSocket.
2. Durable command state machine.
3. Daemon local command journal.
4. HTTP/2 gRPC control plane.
5. HTTP/2 data attach streams.
6. Localhost proxy over HTTP/2.
7. File/range serving over HTTP/2.
8. QUIC data fast path.
9. WebSocket fallback cleanup.
```

Even though QUIC should be scoped from the beginning, the system becomes much easier to reason about if HTTP/2 control and fallback semantics are correct first. QUIC then becomes an optimization over a known-good protocol model rather than a second architecture.

---

# 35. Final target state

The upgraded Bud runtime should satisfy this contract:

```text
A daemon can always reach Bud over HTTP/2 gRPC when normal outbound 443 works.

A daemon opportunistically establishes QUIC for high-performance data streams.

The backend chooses the best data path per stream based on health, policy, and traffic class.

If QUIC fails, existing resumable data streams recover over HTTP/2.

If HTTP/2 data streaming fails in a weird environment, WebSocket carries the same envelopes in degraded mode.

Commands are durable and reconciled independently of transport.

Localhost proxy and file serving are capability-scoped, audited, revocable, and resumable where appropriate.

Terminal/control traffic remains interactive even during bulk transfer.

No fallback path bypasses auth, policy, typed errors, or stream lifecycle.
```

The north-star implementation principle:

> **Bud should have one protocol, multiple transports, durable control, opportunistic fast data, and no security exceptions for compatibility mode.**

[1]: https://grpc.io/docs/what-is-grpc/core-concepts/ "Core concepts, architecture and lifecycle | gRPC"
[2]: https://www.rfc-editor.org/rfc/rfc9113.html "RFC 9113: HTTP/2"
[3]: https://www.rfc-editor.org/info/rfc9000 "Information on RFC 9000 » RFC Editor"
[4]: https://www.rfc-editor.org/rfc/rfc9114.html "RFC 9114: HTTP/3"
[5]: https://www.rfc-editor.org/rfc/rfc6455.html "RFC 6455: The WebSocket Protocol"
[6]: https://grpc.io/docs/guides/flow-control/ "Flow Control | gRPC"
[7]: https://grpc.io/docs/guides/status-codes/ "Status Codes | gRPC"

