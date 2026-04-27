# Progress Checklist: Network Upgrade

## Current PR: HTTP/2 Network Upgrade

- [x] Record HTTP/2 upgrade vs. follow-on feature scope split
- [x] Validate gRPC control/data replacement with real-daemon terminal smoke coverage
- [x] Validate file stream foundation over gRPC control plus HTTP/2 data with real-daemon smoke coverage
- [x] Validate proxy stream foundation over gRPC control plus HTTP/2 data with real-daemon smoke coverage
- [x] Defer file-serving productization to [../../design/network-upgrade-file-serving-productization.md](../../design/network-upgrade-file-serving-productization.md)
- [x] Defer QUIC transport to [../../design/network-upgrade-quic-transport.md](../../design/network-upgrade-quic-transport.md)
- [x] Defer web-serving productization to [../../design/network-upgrade-web-serving-productization.md](../../design/network-upgrade-web-serving-productization.md)
- [x] Defer WebSocket data fallback to [../../design/network-upgrade-websocket-fallback.md](../../design/network-upgrade-websocket-fallback.md)
- [ ] Confirm retained file/proxy foundation routes have the required owner/unauth validation before product exposure

## Phase 0: Protocol Envelope And Transport Boundary

- [x] Choose protobuf tooling for Rust and TypeScript
- [x] Define `BudEnvelope v1`
- [x] Define typed payloads for current daemon frames
- [x] Define typed `BudError`
- [x] Add cross-language conformance fixtures
- [x] Add service daemon transport router interface
- [x] Add daemon transport client interface
- [x] Carry canonical envelopes over WebSocket compatibility
- [x] Bound daemon terminal output chunk sizes
- [x] Update `docs/proto.md` and affected specs

## Phase 1: Durable Control And Reconciliation

- [x] Define operation lifecycle states
- [x] Define stream lifecycle states
- [x] Add device-session persistence
- [x] Add transport-session persistence
- [x] Add durable operation persistence
- [x] Add durable stream persistence
- [x] Add daemon local journal
- [x] Add reconnect reconciliation protocol
- [x] Add service reconciliation handling
- [x] Add gateway drain semantics
- [x] Generate and verify Drizzle migrations
- [x] Update DB/runtime specs

## Phase 1.5: gRPC Stack Interop Validation

- [x] Add Buf spike scaffolding
- [x] Implement Node Connect native-gRPC-over-HTTP/2 candidate
- [x] Implement Rust tonic client harness
- [x] Validate long-lived bidi control stream
- [x] Validate server directive while client streams heartbeats
- [x] Validate client cancellation
- [x] Validate server cancellation
- [x] Validate deadline exceeded behavior
- [x] Validate max message size behavior
- [x] Validate metadata propagation
- [x] Validate status/error details
- [x] Validate gateway drain smoke behavior
- [x] Validate reconnect under load
- [x] Validate 1000+ stream open/close cycles
- [x] Validate concurrent attach streams
- [x] Validate slow receiver/backpressure shape
- [x] Validate proxy/file streaming fallback shape
- [x] Run `@grpc/grpc-js` comparison if Connect is ambiguous or fails
- [x] Record daemon-gateway runtime decision
- [x] Update Phase 2 plan with selected runtime and version pins

## Phase 2: HTTP/2 gRPC Control Plane

- [ ] Confirm selected gRPC service stack and deployment/front-door support
- [x] Define `BudControl.Connect`
- [x] Implement daemon signed identity or documented transition mechanism
- [x] Implement service control gateway
- [x] Implement daemon control client
- [x] Register device and transport sessions from gRPC control
- [x] Move heartbeat/offline detection to gRPC control
- [x] Move operation control/reconciliation to gRPC control
- [x] Keep WebSocket control compatibility during rollout
- [x] Update protocol and specs

## Phase 2.1: Control-Plane Hardening

- [x] Add service signal handling so `SIGTERM` / `SIGINT` call `server.close()`
- [x] Finalize active gRPC trackers during gateway shutdown
- [x] Close durable gRPC `device_session` and `transport_session` rows on service drain
- [x] Mark Bud offline when no alternate transport remains
- [x] Confirm invalid gRPC enrollment credentials return `AUTH_FAILED`
- [x] Add focused finalization unit coverage
- [x] Record Phase 3 handoff assumptions

## Phase 3: HTTP/2 Data Fallback

- [x] Define `BudData.Attach` or equivalent
- [x] Define traffic classes and priorities
- [ ] Add stream credit model (schema and attach acknowledgement exist; runtime enforcement deferred)
- [x] Add bounded buffering limits for the initial terminal-output data channel
- [x] Implement service data-plane router
- [x] Implement daemon data client
- [x] Migrate terminal output data path
- [x] Preserve browser REST/SSE behavior
- [ ] Add fallback/degraded-state metrics
- [x] Update protocol and specs

## Phase 3.1: Data Fallback Hardening

- [x] Close subordinate `h2_data` sessions when their owning `h2_grpc` control tracker closes
- [x] Keep active data tracker frame and byte counters for smoke assertions and close-log context
- [x] Add local control-fallback smoke coverage for data-disabled terminal output
- [x] Add local large-output smoke coverage for multi-frame data output and input dispatch latency
- [ ] Promote fallback/degraded-state visibility from local logs/smoke output into durable metrics or operator APIs

## Phase 4: Localhost Proxy And File Reads

- [x] Add generic file/web-serving stream foundation over `BudData.Attach`
- [x] Enforce runtime stream credits and max in-flight bytes for file/web-serving streams
- [x] Propagate typed stream reset/close states to service runtime callers
- [x] Fail file/web-serving opens closed when HTTP/2 data is unavailable
- [x] Define proxy session API contract
- [x] Add proxy session schema and migrations
- [x] Implement service proxy edge contract and GET/HEAD streaming path
- [x] Implement daemon localhost proxy adapter
- [x] Define file session API contract
- [x] Add file session schema and migrations
- [x] Implement service file edge contract
- [x] Implement daemon file stat/read/range adapter
- [x] Add default service-side file root/path policy
- [x] Add default daemon file local policy
- [x] Add proxy session create/revoke audit events
- [x] Add proxy stream open audit events and durable stream close/reset state
- [x] Add file session create/revoke audit events
- [x] Defer file-serving product adoption to follow-on PR
- [x] Defer web-serving product adoption to follow-on PR
- [x] Validate Phase 4.2 unit/type coverage with QUIC disabled
- [x] Validate Phase 4.4 real-daemon file smoke with QUIC disabled
- [x] Update protocol and affected specs for Phase 4.2
- [x] Update affected specs and migrations for Phase 4.3
- [x] Update affected specs and migrations for Phase 4.4

## Phase 5: QUIC-Preferred Data Streams

- [x] Defer QUIC implementation out of the HTTP/2 upgrade PR
- [ ] Validate QUIC stack and deployment support
- [ ] Add QUIC candidate advertisement
- [ ] Add short-lived QUIC token binding
- [ ] Implement service QUIC data gateway
- [ ] Implement daemon QUIC data client
- [ ] Carry the same envelope/stream frames over QUIC
- [ ] Add transport selector policy for QUIC preferred, HTTP/2 fallback, and bounded WebSocket last-resort fallback
- [ ] Add stream scheduler
- [ ] Add health scoring and fallback
- [ ] Validate terminal/file-stream behavior with forced QUIC failure
- [ ] Validate web-serving behavior with forced QUIC failure in the follow-on PR
- [ ] Update deployment docs and specs

## Phase 6: WebSocket Compatibility Cleanup

- [x] Defer WebSocket data fallback out of the HTTP/2 upgrade PR
- [x] Record design goal that file bytes should be allowed over bounded WebSocket fallback when enabled
- [ ] Define WebSocket compatibility policy
- [ ] Decide exact limits for file-serving bytes over WebSocket fallback
- [ ] Decide whether web-serving bytes are enabled or disabled by default over WebSocket fallback
- [ ] Add degraded limits
- [ ] Add operator controls
- [ ] Add usage metrics and warnings
- [ ] Remove legacy JSON when safe
- [ ] Disable WebSocket compatibility in validation environment
- [ ] Remove WebSocket daemon transport when safe
- [ ] Remove service WebSocket gateway when safe
- [ ] Remove unused dependencies
- [ ] Update protocol docs and specs
