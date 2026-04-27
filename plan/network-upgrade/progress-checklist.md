# Progress Checklist: Network Upgrade

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

- [ ] Define `BudData.Attach` or equivalent
- [ ] Define traffic classes and priorities
- [ ] Add stream credit model
- [ ] Add bounded buffering limits
- [ ] Implement service data-plane router
- [ ] Implement daemon data client
- [ ] Migrate terminal output/input data path
- [ ] Preserve browser REST/SSE behavior
- [ ] Add fallback/degraded-state metrics
- [ ] Update protocol and specs

## Phase 4: Localhost Proxy And File Reads

- [ ] Define proxy session API contract
- [ ] Add proxy session schema and migrations
- [ ] Implement service proxy edge
- [ ] Implement daemon localhost proxy adapter
- [ ] Define file session API contract
- [ ] Add file session schema and migrations
- [ ] Implement service file edge
- [ ] Implement daemon file stat/read/range adapter
- [ ] Add default proxy and file local policies
- [ ] Add audit events
- [ ] Add minimal web adoption
- [ ] Validate with QUIC disabled
- [ ] Update protocol, specs, and DB migration specs

## Phase 5: QUIC Data Fast Path

- [ ] Validate QUIC stack and deployment support
- [ ] Add QUIC candidate advertisement
- [ ] Add short-lived QUIC token binding
- [ ] Implement service QUIC data gateway
- [ ] Implement daemon QUIC data client
- [ ] Carry the same envelope/stream frames over QUIC
- [ ] Add stream scheduler
- [ ] Add health scoring and fallback
- [ ] Validate terminal/proxy/file behavior with forced QUIC failure
- [ ] Update deployment docs and specs

## Phase 6: WebSocket Compatibility Cleanup

- [ ] Define WebSocket compatibility policy
- [ ] Add degraded limits
- [ ] Add operator controls
- [ ] Add usage metrics and warnings
- [ ] Remove legacy JSON when safe
- [ ] Disable WebSocket compatibility in validation environment
- [ ] Remove WebSocket daemon transport when safe
- [ ] Remove service WebSocket gateway when safe
- [ ] Remove unused dependencies
- [ ] Update protocol docs and specs
