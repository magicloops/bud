# Network Upgrade Review

Date: 2026-04-25

Reference: [`reference/protocol-transport-design-goals.md`](../reference/protocol-transport-design-goals.md)

Current implementation reviewed:

- [`docs/proto.md`](../docs/proto.md)
- [`bud/src/app.rs`](../bud/src/app.rs), [`bud/src/protocol.rs`](../bud/src/protocol.rs), [`bud/src/terminal/`](../bud/src/terminal/)
- [`service/src/ws/`](../service/src/ws/), [`service/src/runtime/`](../service/src/runtime/), [`service/src/routes/threads/`](../service/src/routes/threads/)
- [`service/src/db/schema.ts`](../service/src/db/schema.ts), [`service/src/auth/session.ts`](../service/src/auth/session.ts)
- [`web/src/features/threads/use-agent-stream.ts`](../web/src/features/threads/use-agent-stream.ts), [`web/src/features/threads/use-terminal-session.ts`](../web/src/features/threads/use-terminal-session.ts)

## Executive Conclusions

The reference direction is right: Bud should move to one transport-independent protocol, HTTP/2 gRPC as the required daemon control path, HTTP/2 data streams as the required fallback data path, and QUIC as an optional data accelerator. The current implementation is not close to that transport model yet. It treats one JSON WebSocket as the daemon runtime and routes all daemon liveness, auth, terminal control, terminal output, and request/response terminal tool results through that socket.

The browser-facing shape can mostly stay. The web app already uses authenticated REST for writes/state and SSE for live agent/terminal events. That matches the reference goal that web/mobile should not need direct gRPC, QUIC, or daemon connectivity.

The biggest missing foundations are not QUIC. They are:

1. A protobuf envelope and typed payload model that can be carried by WebSocket, gRPC, and QUIC.
2. A service/daemon transport abstraction so runtime code stops importing or depending on `ws/gateway`.
3. Durable command/operation and stream state for reconciliation, retries, and proxy/file sessions.
4. Device identity hardening from long-lived shared secret toward device keypair, signed challenge, revocation, and capability-scoped policy.
5. A stream lifecycle with traffic classes, byte credits, bounded chunks, typed resets, and audit events.

Do not implement QUIC before the web proxy as a critical-path dependency. Design for QUIC now by adding `transport_kind`, `traffic_class`, `stream_id`, health slots, and a data-plane interface, but ship the first localhost proxy and file reads over HTTP/2 gRPC data fallback. QUIC should follow once proxy/file semantics, security policy, and resume behavior are correct over the mandatory fallback path.

## Current System Snapshot

### Daemon to Service

Current daemon reachability is WebSocket-only:

- The daemon CLI has a single `--server` / `BUD_SERVER_URL`, defaulting to `wss://localhost:8443/ws`.
- `BudApp` connects with `tokio_tungstenite::connect_async(...)`.
- The WebSocket handshake sends JSON `hello`, receives `hello_ack` or `hello_challenge`, and answers with HMAC `hello_proof`.
- Heartbeats, legacy `run`, `terminal_ensure`, `terminal_send`, `terminal_observe`, `terminal_output`, readiness, and request results all share the same socket.
- `RunExecutor` and `TerminalManager` receive an `OutboundSender` that is explicitly a WebSocket message sender.
- Terminal output is produced by tmux `pipe-pane` to a local log, then a watcher emits JSON `terminal_output` frames with `seq`, `byte_offset`, and base64 payload.

There is no HTTP/2 gRPC dependency in the daemon (`tonic`, `prost`, `h2`) and no QUIC dependency (`quinn` or equivalent). The daemon has a useful internal terminal backend boundary, but not a network transport boundary.

### Service to Daemon

Current service reachability is also WebSocket-only:

- `server.ts` registers `@fastify/websocket` and mounts `/ws`.
- `service/src/ws/bud-connection.ts` owns daemon auth, heartbeat timeout, active-session replacement, terminal frame parsing, and offline side effects.
- `service/src/ws/session-trackers.ts` is an in-memory `budId -> WebSocket` map.
- `sendFrameToBud(...)` serializes a JSON object directly to the active WebSocket.
- `TerminalSessionStore`, `TerminalRequestDispatcher`, and `TerminalSessionManager` route daemon work through `sendFrameToBud(...)`.

This coupling is the main service-side transport blocker. The terminal runtime itself is close to a reusable application layer; the routing boundary below it needs to become `DaemonTransportRouter` or equivalent rather than `ws/gateway`.

### Service to Web

The browser-facing layer is already aligned with the target model:

- REST creates threads/messages, terminal session records, terminal input/resize, cancel requests, and terminal history reads.
- SSE streams `/api/threads/:thread_id/agent/stream` and `/api/threads/:thread_id/terminal/stream`.
- The web client uses `EventSource` through `createAuthEventSource(...)`.
- Browser auth and ownership checks happen before route handlers attach SSE listeners or read terminal history.

Expected changes here are additive: create proxy/file sessions, expose backend HTTPS URLs, surface degradation states, and maybe add new SSE metadata. The browser should not learn whether daemon data moved over HTTP/2, QUIC, or WebSocket fallback.

### Database and Runtime State

Reusable current state:

- `bud.created_by_user_id`, `thread.created_by_user_id`, `message.created_by_user_id`, and `terminal_session.created_by_user_id` already support the current browser ownership model.
- `terminal_session_output` already stores ordered terminal bytes by `(session_id, byte_offset)`.
- `terminal_session_input_log.user_id` audits human-originated terminal input.
- Agent transcript rows are durable, and `/agent/state` plus agent SSE give a bounded runtime replay model.

Missing durable state:

- No durable command/operation table for daemon work.
- No daemon local command journal.
- No device-session or transport-session table.
- No stream-session table with stream lifecycle, traffic class, byte offsets, credits, reset reasons, and transport kind.
- No proxy-session or file-session tables.
- No audit event table for security-sensitive daemon/proxy/file policy decisions.

## Gap Matrix

| Target area | Current implementation | Gap | Direction |
| --- | --- | --- | --- |
| Transport-independent envelope | JSON frames with `proto`, `type`, `id`, `ts`, `ext` | No protobuf, no `stream_id`, no `command_id`, no traffic class, no trace fields | Define `BudEnvelope v1`; carry it over current WebSocket first |
| HTTP/2 gRPC control | None | WebSocket is the only control channel | Add `BudControl.Connect` after envelope and transport router exist |
| HTTP/2 data fallback | None | Terminal output and tool results share control socket | Add `BudData.Attach` pools and migrate terminal streams before proxy/file |
| QUIC data path | None | No data health scoring or transport candidates | Add schema/interface hooks early; implement after HTTP/2 proxy/file works |
| WebSocket fallback | Current primary JSON protocol | It is not a fallback and would diverge if new features skip it | Convert to compatibility carrier for the same envelope and stream frames |
| Durable command state | Agent messages are durable; terminal requests are not | No command offer/accept/run/reconcile model | Add minimal operation/command state before gRPC cutover |
| Terminal resume | tmux persists; backend stores output offsets | No protocol-level stream resume or daemon reconcile report | Reuse output offsets, add stream checkpoints and reconnect reports |
| Proxy | None | No local HTTP adapter, proxy edge, session token, stream type, or policy | Build 127.0.0.1-only HTTP proxy over HTTP/2 data first |
| File/range serving | None | No file session, path policy, identity, range streams, or mutation handling | Add after proxy stream lifecycle is proven |
| Backpressure | WebSocket send returns boolean; DB soft cap | No byte credits, stream limits, traffic classes, or separate connections | Add app-level credits and per-class limits with HTTP/2 data |
| Auth | Browser auth is strong; daemon uses long-lived `device_secret` HMAC | `device_pubkey` exists but unused; no keypair/mTLS/token binding/revocation | Migrate daemon identity to generated keypair and signed challenges |
| Local policy | Daemon advertises basic terminal capability | No local allow/deny policy for commands, proxy, or files | Add capability manifest and daemon-side policy checks |
| Observability/audit | Logs, DB timestamps, terminal input log, push outbox | No transport metrics, stream metrics, proxy/file audit, gateway drain state | Add metrics and `audit_event` before public proxy/file launch |

## What Can Stay

- The web/mobile API model: authenticated REST plus SSE can remain the product-facing contract.
- The Better Auth browser/native auth foundation and ownership-aware helpers can remain.
- Thread-scoped terminal sessions can remain the core terminal model.
- The tmux backend can remain the first local execution backend; the existing daemon terminal backend trait is useful.
- `terminal_session_output` can remain the source for browser terminal history/backfill.
- `terminal.send` and `terminal.observe` can remain the model-facing tools during the transport migration.
- Device claim bootstrap over REST can remain initially, though the credential it provisions should change.
- A single service process can remain the first deployment shape if internal interfaces separate API, control gateway, data gateway, proxy edge, and registry responsibilities.

## What Must Change

### Daemon

- Split network ownership out of `BudApp` into a transport client interface.
- Replace `OutboundSender = WebSocket message sender` with a protocol/data sender that can target control or data streams.
- Add protobuf encode/decode and conformance tests before changing transport.
- Add daemon session state reporting on reconnect: active terminal sessions, accepted/running commands, last output offsets, supported stream types, and local policy version.
- Add local policy evaluation before terminal/proxy/file side effects.
- Add keypair-backed device identity and signed control-channel authentication.
- Enforce max frame/chunk bytes in the output watcher. Current terminal output watcher can read and send the full log delta as one frame; that can exceed the documented 16 KiB target.

### Service

- Replace `sendFrameToBud(...)` direct WebSocket calls with a transport router interface.
- Replace the in-memory `sessions` map with a device-session registry that can track control gateway ownership, transport sessions, capabilities, last heartbeat, and health scores.
- Keep the WebSocket gateway temporarily, but make it a carrier of the same protobuf envelopes as gRPC/QUIC.
- Add durable operation/command and stream tables before relying on reconnect behavior for proxy/file work.
- Add HTTP/2 gRPC server support or a separate control/data gateway process.
- Add a proxy edge route family that validates proxy sessions before opening daemon streams.
- Add typed Bud errors and map them to HTTP/gRPC/SSE consistently.

### Database

Minimum new tables or equivalents:

- `device_session`: live/recent daemon control epochs, gateway instance, capabilities, heartbeat, drain state.
- `transport_session`: H2 control, H2 data, WebSocket fallback, QUIC data, health score, traffic class, connection metadata.
- `bud_command` or `bud_operation`: durable command/operation lifecycle, idempotency key, owner, device, state, leases, error.
- `bud_stream`: stream lifecycle, type, traffic class, parent command/session, transport kind, byte offsets, credits, reset reason.
- `proxy_session`: user/device/target binding, TTL, allowed methods, capability scope, revocation state.
- `file_session`: user/device/path-or-handle binding, TTL, range policy, content identity, max bytes.
- `audit_event`: security-sensitive events for daemon auth, command/proxy/file decisions, policy denials, transport fallback.

Existing terminal tables should not be thrown away. `terminal_session_output` is a good special-purpose durable output store, and can either remain terminal-specific or later be generalized behind `bud_stream`.

### Web

Most web changes are product features, not transport changes:

- Add UI/API calls to create proxy sessions and file sessions.
- Open backend HTTPS proxy/file URLs; do not connect to the daemon directly.
- Show degraded connectivity when only WebSocket fallback is active or bulk features are disabled.
- Preserve current agent and terminal SSE semantics unless new proxy/file events are needed.

## Security Model

### Current Strengths

- Browser routes require a viewer and use ownership-aware helpers for Bud/thread/session access.
- Cross-user browser access returns `404`; unauthenticated access returns `401`.
- Device claim approval stamps `bud.created_by_user_id` for browser-mediated claims.
- Terminal sessions and messages inherit thread ownership.
- Human terminal input is recorded with `terminal_session_input_log.user_id`.
- Daemon secrets are stored locally with restrictive file permissions.
- Reconnect uses challenge-response rather than sending the persisted device secret over the WebSocket.

### Current Weaknesses

- The daemon identity is a long-lived shared secret, not an asymmetric device identity.
- `bud.device_pubkey` exists in schema but is not used.
- Legacy enrollment-token flow can create Bud rows without an approving user owner.
- There is no daemon-side revocation check beyond backend auth failure.
- No local policy engine exists on the daemon.
- Capabilities are descriptive, not authorization scopes.
- There is no capability-scoped command/proxy/file session model.
- There is no replay protection beyond the current challenge nonce for reconnect.
- There is no durable audit log for daemon auth, policy denial, proxy/file creation, or fallback events.
- WebSocket message rate limiting is still a known gap.

### Target Security Baseline

For the network upgrade, use this baseline before shipping proxy/file features:

- Daemon generates a local keypair during claim.
- Backend stores the public key and owner binding.
- Control connection uses TLS plus signed challenge, mTLS, or a short-lived token bound to the device key.
- Backend authorizes user intent against Bud/thread/session ownership before creating commands, proxy sessions, or file sessions.
- Daemon independently authorizes the exact local action against local policy.
- Most restrictive policy wins; daemon rejection becomes a first-class state, not an internal error.
- Proxy sessions are short-lived, user-scoped, device-scoped, target-scoped, revocable, and audited.
- File sessions are short-lived, user-scoped, device-scoped, path/handle-scoped, byte/range-limited, mutation-aware, revocable, and audited.
- WebSocket fallback carries the same envelopes and policy checks; it never bypasses capability checks.
- QUIC early data should remain disabled for non-idempotent effects.

### Proxy/File Default Policy

Keep the first proxy/file scope intentionally narrow:

- Allow only `http://127.0.0.1:<explicit_port>` for localhost proxy.
- Default proxy methods: `GET` and `HEAD`; opt into `POST` only with explicit capability.
- Default deny LAN IPs, metadata IPs, `0.0.0.0`, Unix sockets, Docker socket, Kubernetes API sockets, SSH agent sockets, and `file://` URLs.
- Strip Bud auth cookies and dangerous hop-by-hop headers before forwarding to local services.
- Use short random session identifiers and per-session origin isolation where deployment supports it.
- File reads should default to approved roots or daemon-issued artifact handles, not arbitrary paths.
- Range reads require content identity where possible; if identity changes, fail with a typed `file.changed` error.

## Recommended Phases

### Phase 0: Freeze Protocol Semantics

Goal: make the current behavior transport-independent without changing deployment.

Deliverables:

- `BudEnvelope v1` protobuf and typed payload messages for current hello/auth/heartbeat/terminal frames.
- `BudError` with stable namespaced codes and retry hints.
- Stream lifecycle and reset reason docs in `docs/proto.md`.
- Shared conformance fixtures that validate encode/decode, unknown-field tolerance, version negotiation, error mapping, and current terminal flows.
- WebSocket compatibility mode carrying the same envelope, preferably binary length-delimited protobuf while retaining tolerant JSON during rollout.
- Service transport router interface replacing direct `ws/gateway` imports from terminal runtime.
- Daemon network client interface replacing direct WebSocket `OutboundSender` usage in run/terminal modules.

This phase is the main anti-ballooning move. It lets the team change protocol and transport separately.

### Phase 1: Durable Control and Reconciliation

Goal: make daemon work survive reconnects and backend deploys better before adding new stream-heavy features.

Deliverables:

- Minimal `bud_operation`/`bud_stream` state for daemon-directed work.
- Device-session registry that can survive process boundaries conceptually, even if the first implementation keeps live routing in process.
- Daemon local journal for accepted operations and active stream checkpoints.
- Reconnect reconciliation report.
- Explicit `UNKNOWN` state when the outcome cannot be proven.
- Gateway drain semantics for deploys.

Do not build a broad workflow engine. Keep the first operation family focused on terminal/session work plus the upcoming proxy/file stream primitives.

### Phase 2: HTTP/2 gRPC Control Plane

Goal: move daemon reachability, auth, heartbeat, policy, cancel, transport negotiation, and reconciliation off WebSocket.

Deliverables:

- `BudControl.Connect` bidirectional stream.
- Keypair-backed daemon authentication or a deliberate transition step from the current shared secret.
- Capability manifest and backend policy update messages.
- Heartbeat and offline detection through control events.
- Command/operation offer, accept/reject, started/finished, cancel, and reconcile events.
- Transport candidates for H2 data, WebSocket fallback, and future QUIC.

Success criteria:

- A daemon can connect, authenticate, heartbeat, receive terminal directives, and report state over HTTP/2 control.
- WebSocket is no longer required for control in environments where HTTP/2 works.

### Phase 3: HTTP/2 gRPC Data Fallback

Goal: make the required data path real before adding QUIC.

Deliverables:

- `BudData.Attach` stream pool for daemon-outbound reverse-tunnel semantics.
- Separate channels or connections by traffic class: control, interactive, bulk, telemetry.
- Terminal output/input and terminal send/observe results over `INTERACTIVE` data streams or a clearly bounded control/data split.
- Stream credits, max chunk sizes, in-flight limits, and typed resets.
- WebSocket fallback for the same stream frames.

Success criteria:

- Current terminal UX works without WebSocket as the primary daemon data path.
- Terminal input does not wait behind terminal output or future bulk bytes.
- Current browser REST/SSE behavior is unchanged.

### Phase 4: Localhost Proxy and File Reads over HTTP/2

Goal: ship the new product capabilities on the mandatory fallback path.

Deliverables:

- Proxy session create endpoint, proxy edge route, and `LOCALHOST_HTTP_PROXY` stream type.
- 127.0.0.1-only target policy with explicit port and method limits.
- Response/request streaming, Range support, local SSE support, and optional WebSocket upgrade only behind explicit capability.
- File session create endpoint and `FILE_READ` stream type.
- File stat/read/range payloads, content identity, max byte policy, and mutation handling.
- Audit events for session creation, stream open/close/reset, policy denial, and expiry.

Success criteria:

- Localhost webview works with QUIC disabled.
- File/range reads work with QUIC disabled.
- Security policy can deny unsafe targets and paths before the daemon touches them.

### Phase 5: QUIC Data Fast Path

Goal: optimize proven data semantics, not invent a second architecture.

Deliverables:

- Short-lived QUIC session token bound to the authenticated control session.
- QUIC data gateway and daemon data client.
- Bud-over-QUIC stream framing using the same envelope and stream lifecycle.
- Health scoring, promotion/demotion, cooldown, and fallback to HTTP/2.
- Scheduler prioritizing terminal input, resets/cancel, active proxy HTML/API, terminal output, static assets, range reads, bulk, telemetry.

Success criteria:

- UDP-blocked environments fall back to HTTP/2 without feature loss.
- QUIC improves parallel webview assets and range reads when healthy.
- Terminal remains interactive during bulk transfer.

### Phase 6: WebSocket Compatibility Cleanup

Goal: keep WebSocket as a constrained fallback rather than an alternate product.

Deliverables:

- Same protobuf envelope and conformance tests as H2/QUIC.
- Degraded limits: fewer proxy streams, lower chunk sizes, throttled/disabled bulk.
- No JSON-only commands or WebSocket-only proxy/file behavior.
- Explicit operational switch for disabling WebSocket fallback once confidence is high.

## QUIC Timing Recommendation

Add QUIC-shaped fields and interfaces early, but do not implement QUIC before the first proxy.

Good early work:

- `transport_kind` enum includes `h2_grpc`, `quic`, `websocket`.
- Stream records include `traffic_class`, `priority`, `resume_policy`, `transport_session_id`.
- Control protocol can advertise/probe QUIC candidates.
- Proxy/file code calls a data-plane router instead of hardcoding HTTP/2.

Work to defer:

- QUIC gateway deployment.
- QUIC health scoring implementation.
- QUIC stream scheduler.
- QUIC range-read optimization.

Reason: the proxy and file security semantics are harder and more important than the UDP transport. If those semantics are correct over HTTP/2, QUIC becomes an optimization. If they are not correct, QUIC only adds another path to secure and debug.

## Project Size Controls

Keep the first implementation narrow:

- Do not implement raw TCP, LAN proxy, Unix sockets, Docker/Kubernetes sockets, or arbitrary file paths.
- Do not require splitting the backend into multiple deployed services; split interfaces first.
- Do not make mobile/web clients transport-aware.
- Do not implement generic file writes in the first tranche.
- Do not implement QUIC on the critical path to localhost proxy.
- Do not rework the agent tool surface unless the transport abstraction forces it.
- Do not replace tmux while doing the network upgrade.

## Open Decisions

- Protobuf/gRPC stack choice for Node service: `@grpc/grpc-js`, Connect/Buf, or a separate gateway implementation.
- Rust daemon stack choice: likely `tonic`/`prost` for gRPC and `quinn` or equivalent for QUIC, but this needs a library/deployment spike.
- Whether device authentication moves directly to keypair/mTLS or through a transitional signed-token model.
- Whether command signing needs user-verifiable end-to-end semantics or backend-authenticated commands are enough for the first hosted product.
- Whether terminal output remains in terminal-specific tables forever or becomes a specialized view of a generic `bud_stream` output store.
- How much proxy/file buffering the hosted backend may do under slow clients.
- Which deployment front door will support HTTP/2 gRPC and future QUIC cleanly for self-hosted and hosted modes.

## Bottom Line

The migration should be ordered around protocol correctness and mandatory fallback capability:

```text
protobuf envelope over current WebSocket
-> durable operation/stream state
-> HTTP/2 gRPC control
-> HTTP/2 gRPC data fallback
-> localhost proxy and file/range serving over HTTP/2
-> QUIC fast path
-> WebSocket fallback cleanup
```

That keeps the project bounded while still shaping every early decision so QUIC can be added without a second protocol or a security exception.
