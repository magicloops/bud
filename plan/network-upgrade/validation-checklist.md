# Validation Checklist: Network Upgrade

Manual validation pending.

## Automated Verification Completed

- [x] Bud unit tests pass (`cargo test --manifest-path /Users/adam/bud/bud/Cargo.toml`)
- [x] Service typecheck passes (`pnpm --dir /Users/adam/bud/service exec tsc --project tsconfig.json --noEmit`)
- [x] Service lint passes (`pnpm --dir /Users/adam/bud/service lint`)
- [x] Service unit tests pass (`pnpm --dir /Users/adam/bud/service test`)
- [ ] Web tests/lint/build pass if web files are changed
- [x] Cross-language protobuf conformance tests pass (`proto/fixtures/legacy-terminal-ensure.json` plus typed payload dispatch tests in service and Bud)
- [x] Drizzle migrations are generated and reviewed for deployable schema changes (`0013_strange_nocturne.sql`)
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

- [ ] Daemon authenticates over HTTP/2 gRPC control
- [ ] Invalid daemon signatures or credentials are rejected
- [ ] Heartbeat/offline behavior works without WebSocket
- [ ] Capability manifest and policy version are recorded
- [ ] Operation offers and cancellations work over gRPC control
- [ ] Reconciliation works over gRPC control
- [ ] WebSocket compatibility still works for an older daemon

## Phase 3 Validation

- [ ] Terminal output streams over HTTP/2 data
- [ ] Terminal input remains responsive during large output
- [ ] Stream credits prevent unbounded buffering
- [ ] Typed resets propagate to service/runtime callers
- [ ] Browser terminal SSE/history behavior is unchanged
- [ ] HTTP/2 data disabled path falls back only according to policy
- [ ] Degraded/fallback state is visible in logs/metrics

## Phase 4 Validation

- [ ] Authenticated owner can create a localhost proxy session
- [ ] Non-owner receives `404` for another user's proxy/file session
- [ ] Unauthenticated browser request receives `401`
- [ ] Proxy only allows `http://127.0.0.1:<explicit_port>` by default
- [ ] Proxy denies LAN, metadata, wildcard, Unix socket, Docker, Kubernetes, SSH agent, and `file://` targets
- [ ] Proxy strips unsafe headers and Bud auth cookies
- [ ] Proxy supports streaming local HTTP responses
- [ ] Local SSE through proxy works if in scope
- [ ] File stat/read works for approved handle/root
- [ ] File range read works with content identity
- [ ] File mutation during range read returns typed change error
- [ ] Expired/revoked sessions fail closed
- [ ] Audit events are recorded for create/open/close/reset/deny/expire
- [ ] Proxy and file features work with QUIC disabled

## Phase 5 Validation

- [ ] QUIC session token is bound to authenticated control session
- [ ] QUIC carries the same envelope and stream frames as HTTP/2 data
- [ ] UDP-blocked environment falls back to HTTP/2 data
- [ ] Unhealthy QUIC is demoted with cooldown
- [ ] Terminal input remains responsive during bulk transfer
- [ ] Proxy asset loading improves when QUIC is healthy
- [ ] File range reads work over QUIC and HTTP/2 fallback

## Phase 6 Validation

- [ ] WebSocket compatibility has explicit degraded limits
- [ ] Metrics identify active WebSocket and legacy JSON usage
- [ ] Legacy JSON can be disabled without affecting current supported daemons
- [ ] WebSocket compatibility can be disabled in a validation environment
- [ ] HTTP/2-only daemon path remains green after WebSocket disablement
- [ ] Final dependency cleanup removes unused WebSocket packages/crates when safe

## Security And Ownership

- [ ] Every browser-facing read/write/stream resolves the authenticated viewer first
- [ ] List endpoints filter by owner in SQL
- [ ] Stream/proxy/file endpoints authorize before attaching listeners or daemon streams
- [ ] Daemon verifies local policy before terminal/proxy/file side effects
- [ ] Capability denial is surfaced as a typed operation/stream error
- [ ] Revocation takes effect for device/proxy/file sessions
- [ ] Audit events contain actor, Bud, resource, action, outcome, and correlation ID

## Docs And Rollout

- [x] `docs/proto.md` reflects shipped transport and payload contracts
- [x] Bud/service specs match changed folders and files
- [x] DB specs and migration specs match schema changes
- [ ] Deployment docs describe HTTP/2 and QUIC requirements
- [ ] Rollback path is documented for each transport cutover
- [ ] Web/mobile handoff confirms clients remain REST/SSE-only
