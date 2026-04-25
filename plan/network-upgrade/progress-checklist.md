# Progress Checklist: Network Upgrade

## Phase 0: Protocol Envelope And Transport Boundary

- [ ] Choose protobuf tooling for Rust and TypeScript
- [ ] Define `BudEnvelope v1`
- [ ] Define typed payloads for current daemon frames
- [ ] Define typed `BudError`
- [ ] Add cross-language conformance fixtures
- [ ] Add service daemon transport router interface
- [ ] Add daemon transport client interface
- [ ] Carry canonical envelopes over WebSocket compatibility
- [ ] Bound daemon terminal output chunk sizes
- [ ] Update `docs/proto.md` and affected specs

## Phase 1: Durable Control And Reconciliation

- [ ] Define operation lifecycle states
- [ ] Define stream lifecycle states
- [ ] Add device-session persistence
- [ ] Add transport-session persistence
- [ ] Add durable operation persistence
- [ ] Add durable stream persistence
- [ ] Add daemon local journal
- [ ] Add reconnect reconciliation protocol
- [ ] Add service reconciliation handling
- [ ] Add gateway drain semantics
- [ ] Generate and verify Drizzle migrations
- [ ] Update DB/runtime specs

## Phase 2: HTTP/2 gRPC Control Plane

- [ ] Validate gRPC service stack and deployment/front-door support
- [ ] Define `BudControl.Connect`
- [ ] Implement daemon signed identity or documented transition mechanism
- [ ] Implement service control gateway
- [ ] Implement daemon control client
- [ ] Register device and transport sessions from gRPC control
- [ ] Move heartbeat/offline detection to gRPC control
- [ ] Move operation control/reconciliation to gRPC control
- [ ] Keep WebSocket control compatibility during rollout
- [ ] Update protocol and specs

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

