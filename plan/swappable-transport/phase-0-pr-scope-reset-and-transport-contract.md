# Phase 0: PR Scope Reset And Transport Contract

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: In progress
**Priority**: Urgent

---

## Objective

Make the new transport direction explicit before more code lands, then close the current PR around the existing terminal path over binary `BudEnvelope` WebSocket.

This phase does not need to delete the HTTP/2 work. It should reframe the active branch as protocol and stream foundation work, define the carrier contract that WebSocket, HTTP/2, and future QUIC adapters must satisfy, and investigate whether the current terminal/control payloads can move off the whole-frame `frame_json` bridge now.

## Kickoff Problem

At kickoff, the existing network-upgrade docs and parts of the implementation still implied:

- HTTP/2 gRPC is the required daemon control path
- HTTP/2 data is the required data fallback
- WebSocket exists only as a degraded fallback
- file/proxy streams can fail closed when gRPC data is unavailable
- typed payload oneof fields still carry the old JSON frame body through `frame_json`
- the existing terminal path has not yet proven binary `BudEnvelope` over WebSocket without the JSON compatibility body

That is backwards for the revised deployment goal. Self-hosted Bud must work over WebSocket first.

## First Step: Terminal Payload Cutover Investigation

Before implementing new file/proxy stream behavior, inventory the current terminal/control frames and decide whether this PR can remove whole-frame `frame_json` from the active terminal path.

Required inventory:

- `hello`
- `hello_ack`
- `hello_challenge`
- `hello_proof`
- `heartbeat`
- `heartbeat_ack`
- `terminal_ensure`
- `terminal_status`
- `terminal_input`
- `terminal_resize`
- `terminal_close`
- `terminal_send`
- `terminal_send_result`
- `terminal_observe`
- `terminal_observe_result`
- `terminal_output`
- `terminal_ready`
- `reconnect_report`
- `reconciliation_decision`

For each frame:

1. Compare the current JSON shape to [../../proto/bud/v1/bud.proto](../../proto/bud/v1/bud.proto).
2. Mark fields that already have direct protobuf fields.
3. Add missing direct protobuf fields if the active terminal path needs them.
4. Keep explicit nested JSON fields only where the nested document is intentionally dynamic, such as capabilities, readiness, deltas, or assessment details.
5. Remove whole-frame `frame_json` from the active terminal encode/decode path if the mapping is complete enough.

The preferred outcome is:

```text
WebSocket binary BudEnvelope
  -> typed terminal/control payload oneof
  -> direct protobuf fields
  -> existing terminal runtime structs
```

The fallback outcome, if field-level mapping is not feasible in this PR, must document the exact blocker and keep `frame_json` as a temporary compatibility bridge only for terminal. File/proxy product paths should still be envelope-only and should not add new `frame_json` reliance.

### Investigation Result

The terminal/control mapping is feasible for the current PR.

Phase 0 added direct protobuf coverage for the reconnect metadata that was missing from `OperationStatus` and `StreamStatus`, then cut the active WebSocket terminal/control codec over to typed payload fields. Phase 7 later moved the core data-plane lifecycle frames to typed fields as well. `frame_json` remains decode-compatible and remains available for gRPC adapter transition paths plus proxy/file open-result frames, but the active WebSocket terminal/control and core stream lifecycle paths no longer depend on whole-frame `frame_json`.

Because the product is still internal, this PR does not carry a legacy JSON terminal compatibility mode. The daemon sends bootstrap `hello` as binary `BudEnvelope`, and the WebSocket gateway requires `bud_envelope.version = 1` and `bud_envelope.websocket_binary = true` before auth/registration. The service may parse a pre-negotiation JSON `hello` only to return a useful protocol error to unsupported clients. Post-negotiation JSON frames fail with `PROTO_VERSION_MISMATCH`, and unknown `BudEnvelope` payload oneof fields fail with typed `UNSUPPORTED_PAYLOAD`.

## Implementation Steps

1. Inventory terminal/control payloads and decide whether to remove active terminal `frame_json` now.
2. Mark `plan/swappable-transport/` as the forward implementation plan for this pivot.
3. Keep `plan/network-upgrade/` as historical context for the HTTP/2-first branch work.
4. Update PR notes and docs that describe the current branch as "moving off WebSockets".
5. Replace that wording with "moving off JSON-only WebSocket semantics".
6. Define a carrier contract for:
   - authenticated control send/receive
   - data-frame send/receive
   - control-only, data-only, and control+data carrier roles
   - stream-family capability advertisement
   - drain/finalize
   - degraded limits
   - durable `transport_session` linkage
7. Name the mandatory baseline:
   - WebSocket binary `BudEnvelope`
   - one physical socket carries control plus data by default
   - an optional second data WebSocket may register later without product-route changes
   - optional carriers must share protocol semantics
8. Cut the existing terminal path to binary `BudEnvelope` over WebSocket.
9. Reject legacy JSON frames after binary-envelope capability negotiation.
10. Return a typed unsupported-payload error for unknown envelope payload fields.
11. Prove terminal ensure/send/output/reconnect with gRPC disabled.

## Acceptance Criteria

- [x] The plan/docs state that WebSocket is the mandatory open-source baseline.
- [x] The plan/docs state that HTTP/2 gRPC is optional, not required for correctness.
- [x] The plan/docs state that QUIC is deferred as a data-plane optimization.
- [x] The plan/docs state that the current PR closes on terminal-over-envelope, with file/proxy product paths deferred.
- [x] Terminal/control payload field coverage is inventoried.
- [x] Active terminal WebSocket traffic uses binary `BudEnvelope`.
- [x] Active terminal payloads do not use whole-frame `frame_json`, unless a concrete blocker is documented.
- [x] The carrier contract names the required behavior every carrier must provide.
- [x] The carrier contract supports one default control+data WebSocket and an optional future data-only WebSocket.
- [ ] File viewer and web proxy product work are blocked on WebSocket-only stream smokes, not HTTP/2-only smokes.

## Validation

- Review docs for old phrases:
  - `required daemon control`
  - `required fallback`
  - `worst-case compatibility`
  - `move off WebSockets`
- Confirm remaining uses are either historical context or explicitly marked as superseded by this plan.
- Real-daemon terminal smoke with all gRPC env vars unset:
  - daemon connects over WebSocket
  - service and daemon negotiate binary `BudEnvelope`
  - terminal session is ensured
  - terminal input is sent
  - terminal output is received
  - reconnect reconciliation still works
  - `pnpm --dir /Users/adam/bud/service smoke:ws-terminal`
- Conformance or focused codec tests prove terminal/control payloads are typed protobuf payloads, not `LegacyJsonPayload` or typed `frame_json`.
  - `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/proto/wire.test.ts`
  - `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/ws/bud-connection.test.ts src/ws/gateway.test.ts`
  - `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/grpc/envelope-codec.test.ts`
  - `cargo test --manifest-path bud/Cargo.toml proto_wire --lib`
  - `pnpm --dir /Users/adam/bud/service build`
  - `cargo check --manifest-path bud/Cargo.toml`

## Specs To Update

- [x] [../../bud.spec.md](../../bud.spec.md)
- [x] [../../docs/proto.md](../../docs/proto.md)
- [x] [../../proto/bud/v1/v1.spec.md](../../proto/bud/v1/v1.spec.md)
- [x] [../../service/src/proto/proto.spec.md](../../service/src/proto/proto.spec.md)
- [x] [../../service/src/ws/ws.spec.md](../../service/src/ws/ws.spec.md)
- [x] [../../bud/src/src.spec.md](../../bud/src/src.spec.md)
- [x] [../network-upgrade/network-upgrade.spec.md](../network-upgrade/network-upgrade.spec.md) if we choose to mark the old plan as superseded
- [x] [swappable-transport.spec.md](./swappable-transport.spec.md)

## Notes

This phase is still mostly a scope and contract reset, but it now has one concrete merge target: prove the existing terminal system over WebSocket `BudEnvelope` before implementing file/proxy product paths.
