# Implementation Spec: Network Upgrade

**Status**: Draft
**Created**: 2026-04-25
**Review Doc**: [../../review/network-upgrade.md](../../review/network-upgrade.md)
**Reference Goals**: [../../reference/protocol-transport-design-goals.md](../../reference/protocol-transport-design-goals.md)
**Folder Spec**: [network-upgrade.spec.md](./network-upgrade.spec.md)
**Progress Checklist**: [progress-checklist.md](./progress-checklist.md)
**Validation Checklist**: [validation-checklist.md](./validation-checklist.md)
**Phase 0**: [phase-0-protocol-envelope-and-transport-boundary.md](./phase-0-protocol-envelope-and-transport-boundary.md)
**Phase 1**: [phase-1-durable-control-and-reconciliation.md](./phase-1-durable-control-and-reconciliation.md)
**Phase 1.5**: [phase-1.5-grpc-stack-interop-validation.md](./phase-1.5-grpc-stack-interop-validation.md)
**Runtime Decision**: [phase-1.5-runtime-decision.md](./phase-1.5-runtime-decision.md)
**Phase 2**: [phase-2-http2-grpc-control-plane.md](./phase-2-http2-grpc-control-plane.md)
**Phase 2.1**: [phase-2.1-control-hardening.md](./phase-2.1-control-hardening.md)
**Phase 3**: [phase-3-http2-data-fallback.md](./phase-3-http2-data-fallback.md)
**Phase 3.1**: [phase-3.1-data-hardening.md](./phase-3.1-data-hardening.md)
**Phase 4**: [phase-4-localhost-proxy-and-file-reads.md](./phase-4-localhost-proxy-and-file-reads.md)
**Phase 5**: [phase-5-quic-data-fast-path.md](./phase-5-quic-data-fast-path.md)
**Phase 6**: [phase-6-websocket-compatibility-cleanup.md](./phase-6-websocket-compatibility-cleanup.md)

---

## Context

Bud currently treats the daemon-service WebSocket as the whole daemon runtime. The single JSON socket carries authentication, heartbeat, terminal session lifecycle, terminal input, terminal output, request/response tool results, and legacy run traffic. That architecture worked for the current terminal product, but it is the wrong foundation for daemon-hosted web proxying, file viewing, range reads, and later high-throughput stream features.

The target direction from the reference goals is:

- one transport-independent Bud protocol
- HTTP/2 gRPC as the required daemon control path
- HTTP/2 data streams as the required fallback data path
- QUIC as an optional data fast path
- WebSocket retained only as a constrained compatibility carrier during rollout
- browser and mobile clients staying on service-owned REST plus SSE

The review found that QUIC is not the first hard problem. The first hard problems are the protocol envelope, transport abstraction, durable command/stream state, security policy, and a mandatory HTTP/2 fallback path that can ship the first proxy/file features without UDP.

## Objective

Move Bud from WebSocket-only daemon networking to a transport-independent protocol stack that can safely support terminal traffic, localhost web proxying, file/range reads, and later QUIC acceleration.

By the end of this plan:

- daemon-service semantics are represented by protobuf messages, not transport-specific JSON frames
- service runtime code routes through a daemon transport/data-plane interface instead of importing WebSocket gateway helpers
- daemon runtime code sends protocol/data events through a transport client abstraction instead of a WebSocket sender
- control traffic uses HTTP/2 gRPC in normal deployments
- stream-heavy data traffic works over HTTP/2 without QUIC
- proxy/file sessions are user-scoped, device-scoped, short-lived, policy checked, revocable, and audited
- QUIC can be enabled as an optimization without introducing a second protocol
- WebSocket compatibility is explicitly bounded and removable

## Fixed Decisions

- Web and mobile clients do not connect to Bud daemons directly.
- REST plus SSE remain the product-facing browser/mobile contracts.
- HTTP/2 gRPC is the mandatory daemon control transport.
- Buf is the protobuf schema/tooling standard.
- The Phase 1.5 interop spike selected `@grpc/grpc-js` for the Node daemon gateway.
- The Rust daemon uses `tonic` / `prost` generated from the same canonical `.proto` files.
- Connect-ES may be used for non-daemon APIs, but not for the daemon's long-lived native gRPC bidi control stream.
- HTTP/2 data streams are the mandatory data fallback for terminal, proxy, and file streams.
- QUIC is optional and must not be required for web proxy or file viewer correctness.
- The same protobuf envelope and typed payloads must be carried by WebSocket compatibility, HTTP/2 gRPC, and QUIC.
- WebSocket compatibility must not grow JSON-only features.
- The first proxy scope is localhost HTTP only, with explicit host/port and method limits.
- The first file scope is read-only and handle/root scoped; arbitrary path reads and writes are out of scope.
- Browser-visible reads, writes, proxy sessions, file sessions, and streams must be scoped to the authenticated viewer before service code opens daemon streams.
- The daemon must independently enforce local policy before local side effects.
- Tmux remains the first terminal backend during this plan.
- The current `terminal.send` and `terminal.observe` tool surface remains the agent-facing contract unless a phase explicitly proves a minimal change is needed.

## Target Architecture

```text
Web / mobile
  REST + SSE
      |
      v
Service API and proxy edge
  - ownership/auth checks
  - session creation
  - SSE events
  - proxy/file HTTPS endpoints
      |
      v
Daemon transport router
  - control router
  - data-plane router
  - operation/stream registry
      |
      +-- HTTP/2 gRPC control: required
      +-- HTTP/2 data streams: required fallback
      +-- QUIC data streams: optional fast path
      +-- WebSocket: temporary compatibility carrier
      |
      v
Bud daemon
  - signed device identity
  - local policy
  - terminal backend
  - localhost proxy adapter
  - file read adapter
```

## Core Contract Model

### BudEnvelope

Every daemon-service message should be carried in a versioned protobuf envelope:

- `envelope_version`
- `message_id`
- `correlation_id`
- `operation_id`
- `stream_id`
- `trace_id`
- `bud_id`
- `device_session_id`
- `transport_session_id`
- `sent_at`
- `traffic_class`
- `payload`
- `extensions`

The envelope must tolerate unknown fields and unsupported payloads so new transports and payload types can roll out without flag-day deploys.

### Control Plane

Control plane events cover:

- connect/authenticate/challenge/proof
- capability manifest and policy update
- heartbeat/liveness
- operation offer, accept, reject, started, progress, finished, failed, canceled, unknown
- reconnect reconciliation
- stream open/accept/reject/reset metadata
- transport candidate advertisement and health reporting

### Data Plane

Data plane frames cover:

- terminal interactive streams
- proxy request/response bodies
- file stat/read/range bytes
- stream credit updates
- typed resets
- stream checkpoints

All data frames must have:

- `stream_id`
- `seq`
- `byte_offset` where ordered byte persistence/resume matters
- bounded chunk size
- traffic class
- backpressure/credit handling

## Security Model

### Service-Side Authorization

The service must resolve the authenticated viewer before it creates or attaches to browser-visible resources:

- Bud ownership via existing ownership-aware helpers or successor helpers
- thread ownership before terminal session reads/writes
- proxy session ownership before opening proxy streams
- file session ownership before opening file streams
- `404` for signed-in users accessing another user's resource
- `401` only for unauthenticated browser requests

List endpoints must filter in SQL. Stream endpoints must authorize before attaching listeners or opening daemon streams.

### Daemon Identity

The daemon should move from long-lived shared secret HMAC to keypair-backed identity:

- daemon generates a local keypair during claim or migration
- backend stores `device_pubkey` and owner binding
- daemon signs control-channel challenges
- backend can revoke device identity
- short-lived transport tokens may be bound to the authenticated control session

The transition may temporarily support the current `device_secret` path, but new proxy/file capability should require the hardened path unless a deliberate exception is recorded.

### Local Policy

The daemon must evaluate local policy before local side effects:

- terminal command/input policy
- localhost proxy target/method policy
- file handle/root/range policy
- transport feature policy

Backend authorization is necessary but not sufficient. Daemon denial is a first-class operation/stream state.

### Proxy/File Defaults

Initial defaults:

- proxy target is only `http://127.0.0.1:<explicit_port>`
- proxy methods default to `GET` and `HEAD`
- `POST` requires explicit capability
- deny LAN IPs, metadata IPs, `0.0.0.0`, Unix sockets, Docker socket, Kubernetes sockets, SSH agent sockets, and `file://`
- strip Bud auth cookies and hop-by-hop headers before forwarding
- file reads default to approved roots or daemon-issued handles
- file ranges require content identity when possible
- file changes during range reads fail with a typed `file.changed` error

## Data Model Direction

Expected new tables or equivalent records:

- `device_session`: authenticated daemon control epoch, gateway owner, capabilities, heartbeat, drain state
- `transport_session`: control/data/WebSocket/QUIC session records, health, traffic class, remote metadata
- `bud_operation`: durable daemon-directed operation lifecycle with idempotency and ownership
- `bud_stream`: stream lifecycle, type, parent operation/session, offsets, credits, reset reason
- `proxy_session`: user/device/target/method scope, TTL, revocation, audit identifiers
- `file_session`: user/device/path-or-handle scope, TTL, content identity, range policy, max bytes
- `audit_event`: auth, policy, session, stream, fallback, denial, and revocation events

Existing terminal tables remain useful. `terminal_session_output` should stay the terminal history/backfill source until a later implementation proves a generic stream store should replace it.

Any schema phase must follow the repo DB workflow:

- edit `service/src/db/schema.ts`
- run `pnpm db:push` from `service/` for local validation
- run `pnpm db:generate` for deployable schema changes
- update `service/src/db/db.spec.md`
- update `service/drizzle/migrations/migrations.spec.md`

## Success Criteria

- [ ] protobuf envelope and payload conformance tests exist across service and daemon
- [ ] current terminal flows still work over WebSocket compatibility after envelope rollout
- [ ] runtime code no longer depends directly on `ws/gateway` for daemon routing
- [ ] daemon terminal/run modules no longer depend on a WebSocket sender type
- [ ] durable operation/stream state supports reconnect reconciliation
- [ ] daemon control works over HTTP/2 gRPC
- [ ] terminal traffic works over HTTP/2 data fallback
- [ ] localhost proxy works with QUIC disabled
- [ ] read-only file/range serving works with QUIC disabled
- [ ] QUIC can be enabled or disabled without changing product behavior
- [ ] WebSocket compatibility is bounded, tested, and explicitly removable
- [ ] protocol docs, specs, migrations, and validation checklists match shipped behavior

## Non-Goals

- replacing tmux
- direct browser/mobile daemon connectivity
- raw TCP proxying
- LAN proxying
- arbitrary file system browsing
- file writes
- SSH agent, Docker socket, Kubernetes socket, Unix socket, or metadata-service proxying
- multi-user shared-Bud ACLs
- a generic workflow engine beyond the operation/stream lifecycle needed here
- splitting the service into multiple deployed processes unless implementation proves it necessary

## Phase Overview

| Phase | Document | Priority | Primary Outcome |
|-------|----------|----------|-----------------|
| 0 | [phase-0-protocol-envelope-and-transport-boundary.md](./phase-0-protocol-envelope-and-transport-boundary.md) | Urgent | Define protobuf envelope/payloads and split service/daemon transport boundaries while preserving WebSocket behavior |
| 1 | [phase-1-durable-control-and-reconciliation.md](./phase-1-durable-control-and-reconciliation.md) | Urgent | Add operation/stream/session durability and reconnect reconciliation before adding more stream-heavy features |
| 1.5 | [phase-1.5-grpc-stack-interop-validation.md](./phase-1.5-grpc-stack-interop-validation.md) | Urgent | Validate Rust tonic interoperability and select `@grpc/grpc-js` for the Node daemon gateway |
| 2 | [phase-2-http2-grpc-control-plane.md](./phase-2-http2-grpc-control-plane.md) | High | Move daemon auth, heartbeat, negotiation, policy, and operation control to HTTP/2 gRPC using `@grpc/grpc-js` on the service and `tonic` on the daemon |
| 2.1 | [phase-2.1-control-hardening.md](./phase-2.1-control-hardening.md) | High | Close the immediate gRPC control lifecycle/auth gaps needed before Phase 3 data streams |
| 3 | [phase-3-http2-data-fallback.md](./phase-3-http2-data-fallback.md) | High | Establish mandatory HTTP/2 data streams with backpressure, traffic classes, and terminal parity |
| 4 | [phase-4-localhost-proxy-and-file-reads.md](./phase-4-localhost-proxy-and-file-reads.md) | High | Add generic proxy/file stream handling, then ship localhost proxy and read-only file/range serving over HTTP/2 fallback |
| 5 | [phase-5-quic-data-fast-path.md](./phase-5-quic-data-fast-path.md) | Medium | Add QUIC as an optional data fast path for proven stream semantics |
| 6 | [phase-6-websocket-compatibility-cleanup.md](./phase-6-websocket-compatibility-cleanup.md) | Medium | Constrain, degrade, and eventually remove WebSocket compatibility |

## Expected Files And Areas

### Bud Daemon

- `bud/Cargo.toml`
- `bud/build.rs` if protobuf code generation requires it
- `bud/src/app.rs`
- `bud/src/config.rs`
- `bud/src/grpc_control.rs`
- `bud/src/protocol.rs`
- `bud/src/identity.rs`
- `bud/src/claim.rs`
- `bud/src/terminal/`
- new `bud/src/transport/`
- new `bud/src/policy/`
- new `bud/src/proxy/`
- new `bud/src/files/`

### Service

- `service/package.json`
- `service/src/server.ts`
- `service/src/config.ts`
- `service/src/grpc/`
- `service/src/ws/`
- `service/src/runtime/`
- `service/src/runtime/terminal/`
- `service/src/routes/`
- `service/src/routes/threads/`
- `service/src/db/schema.ts`
- new `service/src/transport/`
- new `service/src/proto/`
- new `service/src/proxy/`
- new `service/src/files/`
- new `service/src/audit/`
- `service/drizzle/migrations/`

### Web

- `web/src/lib/api.ts`
- `web/src/lib/transport.ts`
- thread/workbench UI only for proxy/file affordances and degraded-state display

### Docs / Specs

- `docs/proto.md`
- `spikes/grpc-interop/` for the isolated Phase 1.5 runtime interop harness
- `bud.spec.md`
- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- affected Bud child specs for new folders
- `service/service.spec.md`
- `service/src/src.spec.md`
- affected service child specs
- `service/src/db/db.spec.md`
- `service/drizzle/migrations/migrations.spec.md`
- `web/web.spec.md` and affected web specs if UI changes
- `plan/network-upgrade/network-upgrade.spec.md`

## Sequencing Notes

- Phase 0 must land first. It prevents protocol and transport changes from becoming one large cutover.
- Phase 1 should happen before proxy/file work so reconnect, retries, and unknown outcomes are modeled before the feature depends on them.
- Phase 1.5 should choose the Node daemon-gateway gRPC runtime with Rust tonic interop evidence before Phase 2 starts.
- Phase 2 should move control to HTTP/2 after the gRPC runtime is selected and deployment constraints are known.
- The first Phase 2 slice is opt-in: `GRPC_CONTROL_ENABLED=true` starts the service grpc-js control listener and `BUD_GRPC_CONTROL_URL` makes the daemon use tonic instead of WebSocket.
- Phase 2.1 hardens the local control lifecycle so service `SIGTERM` drains active gRPC sessions through Fastify `onClose`, closes durable session rows, and rejects invalid transition credentials before Phase 3 depends on control-session authority.
- Phase 3 should prove terminal parity over HTTP/2 data before Phase 4 adds proxy/file traffic.
- Phase 3.1 closes the immediate data/control lifecycle gaps and validates normal, fallback, and large-output terminal paths.
- Phase 4 is the first product-feature phase and must work with QUIC disabled. It starts with generic `stream_data` / credit / reset handling because Phase 3.1 only dispatches terminal output over `BudData.Attach`.
- Proxy/file should fail closed when HTTP/2 data is unavailable; terminal-only control fallback must not become implicit proxy/file fallback.
- Phase 5 should reuse the same stream semantics; it must not introduce QUIC-only behavior.
- Phase 6 can overlap with late rollout once H2 paths are stable, but it should not delete compatibility while older daemons still need it.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Protocol and transport changes land together and become impossible to debug | High | High | Phase 0 carries the new envelope over current WebSocket first |
| New DB state grows into a broad workflow engine | Medium | High | Keep operations and streams scoped to daemon work, terminal, proxy, and file sessions |
| Device identity migration blocks all feature work | Medium | High | Add a deliberate transition path, but gate proxy/file on the hardened identity target if feasible |
| Proxy/file policy is too broad on first release | Medium | High | Start with localhost-only proxy and read-only file handles/roots |
| HTTP/2 support in the chosen service stack or deployment front door is awkward | Medium | High | Run the Phase 1.5 Connect-vs-grpc-js interop/deployment spike before cutting over control |
| Connect Node stream semantics are awkward for long-lived tonic daemon streams | Medium | High | Make Connect contingent on Phase 1.5 passing; fall back to `@grpc/grpc-js` for the daemon gateway if it fails |
| Backpressure bugs hurt terminal interactivity | Medium | High | Add traffic classes, bounded chunks, credits, and validation before proxy/file |
| QUIC becomes a second protocol | Medium | High | Require identical envelope, stream lifecycle, and fallback semantics |
| WebSocket fallback becomes permanent feature debt | Medium | Medium | Phase 6 defines degraded limits and a removal switch |

## Rollout Strategy

1. Introduce envelope/protobuf and transport abstractions under current WebSocket behavior.
2. Add durable operation/stream/session state and daemon reconnect reconciliation.
3. Validate the Node daemon-gateway gRPC runtime with a Rust tonic interop spike.
4. Bring up HTTP/2 gRPC control in parallel with WebSocket compatibility.
5. Move terminal data to HTTP/2 data fallback and validate current UX.
6. Ship proxy/file sessions over HTTP/2 fallback.
7. Add QUIC and promote it opportunistically based on health.
8. Constrain and eventually retire WebSocket compatibility.

## Definition Of Done

- [ ] every phase has updated relevant specs and docs before closeout
- [ ] deployable schema changes include checked-in Drizzle migrations
- [ ] protocol changes are reflected in `docs/proto.md`
- [ ] service and daemon have conformance coverage for envelope/payload compatibility
- [ ] browser/mobile product contracts remain REST/SSE
- [ ] ownership checks remain SQL-scoped for all browser-facing resources
- [ ] daemon local policy is enforced for terminal/proxy/file side effects
- [ ] HTTP/2 fallback supports terminal, proxy, and file behavior without QUIC
- [ ] QUIC is optional and has safe fallback
- [ ] WebSocket compatibility is explicitly bounded or removed
