# Validation Checklist: Network Upgrade

Manual validation pending.

## Current PR Acceptance Gate

- [x] Current PR scope split is recorded in [current-pr-http2-upgrade-scope.md](./current-pr-http2-upgrade-scope.md)
- [x] Real daemon validates gRPC control plus HTTP/2 data terminal path
- [x] Real daemon validates file stream foundation over gRPC control plus HTTP/2 data
- [x] Real daemon validates proxy stream foundation over gRPC control plus HTTP/2 data
- [x] File-serving productization is excluded from the current PR acceptance gate
- [x] Web-serving/proxy product behavior is excluded from the current PR acceptance gate
- [x] QUIC is deferred; HTTP/2 fallback remains the current PR correctness path
- [x] WebSocket file/web-serving fallback is deferred to a bounded compatibility follow-on
- [ ] Retained file/proxy foundation routes have owner/unauth validation before product exposure

## Automated Verification Completed

- [x] Bud unit tests pass (`cargo test --manifest-path /Users/adam/bud/bud/Cargo.toml`)
- [x] Service typecheck passes (`pnpm --dir /Users/adam/bud/service exec tsc --project tsconfig.json --noEmit`)
- [x] Service lint passes (`pnpm --dir /Users/adam/bud/service lint`)
- [x] Service unit tests pass (`pnpm --dir /Users/adam/bud/service test`)
- [ ] Web tests/lint/build pass if web files are changed
- [x] Cross-language protobuf conformance tests pass (`proto/fixtures/legacy-terminal-ensure.json` plus typed payload dispatch tests in service and Bud)
- [x] Drizzle migrations are generated and reviewed for deployable schema changes (`0013_strange_nocturne.sql`, `0014_worthless_frank_castle.sql`, `0015_gifted_kinsey_walden.sql`)
- [x] `docs/proto.md` is updated for protocol changes
- [x] Relevant folder specs are updated for changed files/folders

## Phase 0 Validation

- [ ] Current daemon can connect through WebSocket compatibility
- [x] Current terminal ensure carrier encodes through the typed protobuf payload path in unit coverage
- [ ] Current terminal send/observe/output flow works through canonical envelope path in an integration run
- [ ] Legacy JSON compatibility path works only where intentionally retained
- [x] Unknown protobuf fields are tolerated
- [ ] Unsupported payloads return typed errors
- [x] Terminal output chunks respect configured max size
- [x] Service terminal runtime uses transport router abstraction
- [x] Daemon terminal/runtime modules use transport client abstraction

## Phase 1 Validation

- [x] Operation rows record offered/accepted/running/final states
- [x] Stream rows record open/close/reset states
- [ ] Reconnecting daemon reports active operations and streams
- [ ] Service reconciles known states correctly
- [x] Service marks uncertain outcomes `UNKNOWN`
- [x] Gateway drain refuses new long-lived daemon work in router unit coverage
- [ ] Gateway drain resolves existing streams predictably in an integration run
- [ ] Terminal session and output history remain intact across reconnect

## Phase 1.5 Validation

- [x] Buf generation works for both TypeScript and Rust spike code (`pnpm --dir /Users/adam/bud/spikes/grpc-interop generate`, `pnpm --dir /Users/adam/bud/spikes/grpc-interop check`, `cargo check --manifest-path /Users/adam/bud/spikes/grpc-interop/daemon/Cargo.toml`)
- [x] Rust tonic client interoperates with Node Connect server over native gRPC/HTTP2 in basic smoke coverage (`cargo run --manifest-path /Users/adam/bud/spikes/grpc-interop/daemon/Cargo.toml -- control`, `cargo run --manifest-path /Users/adam/bud/spikes/grpc-interop/daemon/Cargo.toml -- drain`)
- [x] grpc-js long-lived bidi control stream remains healthy for the configured test window
- [x] grpc-js server directive arrives while client continues heartbeat streaming
- [x] grpc-js client cancellation is observed by Node in the spike
- [x] grpc-js server cancellation/reset is observed by Rust
- [x] grpc-js deadline exceeded maps to expected gRPC status
- [x] grpc-js max message size limits are enforced predictably
- [x] grpc-js metadata propagates both directions where needed
- [x] grpc-js status/error details are inspectable by Rust
- [x] grpc-js drain notice smoke works
- [x] grpc-js reconnect under load cleans stale streams without corrupting active streams in the spike
- [x] grpc-js 1000 clean stream open/close cycles complete
- [x] grpc-js concurrent attach streams complete independently
- [x] grpc-js slow receiver/backpressure shape works with artificial slow echo
- [x] grpc-js proxy/file streaming fallback shape works over attach-style bidi streams
- [x] `@grpc/grpc-js` comparison is run if Connect behavior is ambiguous or failing
- [x] Runtime decision is recorded with version pins and required local runtime settings
- [ ] Staging/front-door HTTP/2 deployment settings are confirmed

## Phase 2 Validation

- [x] Daemon authenticates over HTTP/2 gRPC control in local dev-token smoke coverage
- [x] Invalid daemon signatures or credentials are rejected in local invalid-token gRPC smoke coverage
- [x] Heartbeat/offline behavior works without WebSocket for daemon-initiated disconnect and service `SIGTERM`
- [ ] Capability manifest and policy version are recorded
- [ ] Operation offers and cancellations work over gRPC control
- [ ] Reconciliation works over gRPC control
- [ ] WebSocket compatibility still works for an older daemon

Local smoke notes from 2026-04-27:

- Service gRPC gateway started on `127.0.0.1:55051` with `GRPC_CONTROL_ENABLED=true`.
- Daemon enrolled over `BUD_GRPC_CONTROL_URL` and persisted `transport_session.transport_kind = "h2_grpc"`.
- Heartbeats updated `device_session.last_heartbeat_at` and `transport_session.last_seen_at`.
- Daemon-initiated disconnect closed the device and transport sessions.
- Reconnect with the same identity file created a new active h2 gRPC session and preserved the prior closed session.
- Service-first shutdown left the newest session active in the DB; this is tracked in [phase-2-deferred-hardening.md](./phase-2-deferred-hardening.md) as graceful shutdown finalization.

Phase 2.1 smoke notes from 2026-04-27:

- Service `SIGTERM` now runs Fastify `onClose`, the gRPC gateway finalizer, terminal offline side effects, and pool shutdown.
- The DB recorded Bud offline plus closed `device_session` and `transport_session` rows with `close_reason = "grpc_control_gateway_shutdown"` and drain timestamps.
- Invalid gRPC enrollment credentials returned a typed `AUTH_FAILED` protocol error frame.
- PTY Ctrl-C against the local `pnpm exec tsx` wrapper can still bypass graceful app shutdown; deploy/runtime validation should use real `SIGTERM` or the process manager's graceful stop path.

## Phase 3 Validation

- [x] `BudData.Attach` data frames encode/decode through typed protobuf payload coverage
- [x] Service rejects data attachments that do not bind to the active control-session ids in unit coverage
- [x] Daemon transport routes `terminal_output` over the bounded data channel and falls back to control when data is closed in unit coverage
- [x] Terminal output streams over HTTP/2 data in local end-to-end smoke coverage
- [x] Terminal input remains responsive during large output
- [x] Generic stream credits prevent unbounded buffering in Phase 4.0 unit coverage
- [x] Typed resets propagate to service/runtime callers for Phase 4 generic stream consumers
- [ ] Browser terminal SSE/history behavior is unchanged
- [x] HTTP/2 data disabled path falls back only according to policy
- [ ] Degraded/fallback state is visible in logs/metrics

Local Phase 3 smoke notes from 2026-04-27:

- `pnpm --dir /Users/adam/bud/service smoke:grpc-data-terminal` builds the local Bud debug binary, starts in-process grpc-js control/data gateways on reserved localhost ports, launches the real Rust daemon with `BUD_GRPC_CONTROL_URL` and `BUD_GRPC_DATA_URL`, and creates a real tmux-backed terminal session through `TerminalSessionManager`.
- The smoke confirmed active `h2_grpc` and `h2_data` transport sessions, sent a marker command into the terminal, found the marker in persisted terminal output, and verified the active gRPC data tracker recorded `terminal_output` frames/bytes.
- Latest local data-path run recorded `data_frames_received = 2`, `data_bytes_received = 677`, `output_bytes = 677`, `input_dispatch_ms = 6`, and `marker_found = true`.

Phase 3.1 smoke notes from 2026-04-27:

- `pnpm --dir /Users/adam/bud/service smoke:grpc-data-terminal:fallback` launched the daemon without `BUD_GRPC_DATA_URL`, confirmed no active `h2_data` transport, found the marker in persisted terminal output, and recorded `data_frames_received = 0`, `data_bytes_received = 0`, `output_bytes = 677`, and `input_dispatch_ms = 6`.
- `pnpm --dir /Users/adam/bud/service smoke:grpc-data-terminal:large` emitted a large terminal-output burst over data, found the marker in persisted terminal output, and recorded `data_frames_received = 17`, `data_bytes_received = 258837`, `output_bytes = 258837`, and `input_dispatch_ms = 7`.
- Fallback/degraded state is still not promoted into durable metrics or operator APIs; Phase 3.1 only exposes it through smoke output, process logs, and active in-memory tracker counters.

## Phase 4 Validation

- [x] Generic `stream_data` / `stream_credit` frames encode through typed gRPC payload coverage
- [x] `proxy_open` / `proxy_open_result` frames encode through typed protobuf payload coverage
- [x] `file_open` / `file_open_result` frames encode through typed protobuf payload coverage
- [x] Service generic stream receive credits enforce offset order and available credit in unit coverage
- [x] Service generic stream send helper refuses writes without available peer credit in unit coverage
- [x] Service proxy runtime receives open results and streams data chunks into an HTTP body in unit coverage
- [x] Daemon generic `stream_*` frames fail closed instead of falling back to control when `h2_data` is unavailable in unit coverage
- [x] Daemon rejects unsupported inbound generic `stream_data` with typed `stream_reset` foundation behavior in local code path
- [x] Daemon validates localhost proxy-open policy for loopback GET/HEAD in unit coverage
- [x] Authenticated owner can create a localhost proxy session route contract
- [x] Authenticated owner can create a file session route contract
- [ ] Non-owner receives `404` for another user's file session and file edge URL
- [ ] Unauthenticated file browser request receives `401`
- [ ] Follow-on web-serving PR validates non-owner `404` / unauthenticated `401` for proxy sessions and proxy edge URLs
- [x] Proxy only allows `http://127.0.0.1:<explicit_port>` by default in service validation coverage
- [x] Proxy denies non-loopback hostnames/IPs at the service contract boundary in validation coverage
- [ ] Daemon denies LAN, metadata, wildcard, Unix socket, Docker, Kubernetes, SSH agent, and `file://` targets before local side effects
- [x] Proxy strips unsafe headers and Bud auth cookies in implementation allowlists
- [x] Proxy supports streaming local HTTP responses in foundation implementation
- [ ] Local SSE through proxy is deferred to follow-on web-serving scope
- [x] File sessions only allow the workspace root and root-relative paths in service validation coverage
- [x] Daemon validates workspace file-open policy in unit coverage
- [x] Daemon range selection enforces max bytes in unit coverage
- [x] File stat/read works for approved handle/root in local end-to-end smoke
- [x] File range read works with content identity in local end-to-end smoke
- [x] File mutation during range read returns typed change error in local end-to-end smoke
- [x] Expired/revoked proxy sessions fail closed at the service edge contract
- [x] Proxy session create/revoke audit events are recorded by the service foundation
- [x] File session create/revoke audit events are recorded by the service foundation
- [ ] Audit events are recorded for all stream close/reset/deny/expire outcomes and file sessions
- [x] Phase 4.2 automated validation runs with QUIC disabled
- [x] Local proxy foundation works end-to-end with a real daemon, local HTTP target, and HTTP/2 data stream
- [x] File stream foundation works end-to-end with QUIC disabled

Local Phase 4.2 smoke notes from 2026-04-27:

- `pnpm --dir /Users/adam/bud/service smoke:grpc-proxy` builds the local Bud debug binary, starts in-process grpc-js control/data gateways, launches the real Rust daemon with `BUD_GRPC_CONTROL_URL` and `BUD_GRPC_DATA_URL`, creates an owned proxy session, and drives a proxied GET through the production proxy edge stream.
- The smoke confirmed active `h2_grpc` and `h2_data` transport sessions, daemon-side localhost proxy forwarding to a loopback target, unsafe request-header stripping for `Authorization` and `Cookie`, durable proxy `bud_operation`/`bud_stream` close state, proxy session active-stream cleanup, and a `proxy.stream_open` audit event.
- Latest local proxy run recorded `status_code = 200`, `body_bytes = 92`, `data_frames_delta = 2`, `data_bytes_delta = 92`, and `stream_receive_offset = 92`.

Local Phase 4.4 smoke notes from 2026-04-27:

- `pnpm --dir /Users/adam/bud/service smoke:grpc-file` builds the local Bud debug binary, starts in-process grpc-js control/data gateways, launches the real Rust daemon with `BUD_GRPC_CONTROL_URL` and `BUD_GRPC_DATA_URL`, creates an owned file session, and drives `HEAD`, full `GET`, range `GET`, and stale range `GET` through the production file edge stream.
- The smoke confirmed active `h2_grpc` and `h2_data` transport sessions, daemon-side workspace file stat/read/range, persisted file content identity, durable file `bud_operation`/`bud_stream` terminal state, file session active-stream cleanup, a `file.stream_open` audit event, and stale content identity rejection as `409 content_changed`.
- Latest local file run recorded `body_bytes = 114`, `range_body = "daemon file"`, `data_frames_delta = 2`, `data_bytes_delta = 125`, status codes `HEAD 200`, `GET 200`, `range 206`, `stale_range 409`, and stream receive offsets `[0, 11, 114]`.

## Phase 5 Validation

- [ ] QUIC session token is bound to authenticated control session
- [ ] QUIC carries the same envelope and stream frames as HTTP/2 data
- [ ] UDP-blocked environment falls back to HTTP/2 data
- [ ] Unhealthy QUIC is demoted with cooldown
- [ ] Terminal input remains responsive during bulk transfer
- [ ] File range reads work over QUIC and HTTP/2 fallback
- [ ] Web-serving asset loading improves when QUIC is healthy in the follow-on PR
- [ ] Bounded WebSocket last-resort fallback decision is validated before file/web-serving bytes use WebSocket compatibility

## Phase 6 Validation

- [ ] WebSocket compatibility has explicit degraded limits
- [ ] File-serving WebSocket fallback is explicitly enabled with limits or explicitly disallowed
- [ ] Web-serving WebSocket fallback is explicitly enabled with limits or explicitly disabled by default
- [ ] Metrics identify active WebSocket and legacy JSON usage
- [ ] Legacy JSON can be disabled without affecting current supported daemons
- [ ] WebSocket compatibility can be disabled in a validation environment
- [ ] HTTP/2-only daemon path remains green after WebSocket disablement
- [ ] Final dependency cleanup removes unused WebSocket packages/crates when safe

## Security And Ownership

- [ ] Every browser-facing read/write/stream resolves the authenticated viewer first
- [ ] List endpoints filter by owner in SQL
- [ ] Stream/file/web-serving endpoints authorize before attaching listeners or daemon streams
- [ ] Daemon verifies local policy before terminal/file/web-serving side effects
- [ ] Capability denial is surfaced as a typed operation/stream error
- [ ] Revocation takes effect for device/file/web-serving sessions
- [ ] Audit events contain actor, Bud, resource, action, outcome, and correlation ID

## Docs And Rollout

- [x] `docs/proto.md` reflects shipped transport and payload contracts
- [x] Bud/service specs match changed folders and files
- [x] DB specs and migration specs match schema changes
- [ ] Deployment docs describe HTTP/2 and QUIC requirements
- [ ] Rollback path is documented for each transport cutover
- [ ] Web/mobile handoff confirms clients remain REST/SSE-only
