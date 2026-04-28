# Progress Checklist: Swappable Transport

## Phase 0: PR Scope Reset And Transport Contract

- [x] Create forward WebSocket-first implementation plan
- [x] Inventory terminal/control JSON frame shapes against typed protobuf payload fields
- [x] Decide whether active terminal/control payloads can remove whole-frame `frame_json` in this PR
- [x] Add any missing terminal/control protobuf fields needed for field-level mapping
- [x] Cut active terminal/control WebSocket traffic to binary `BudEnvelope`
- [x] Send daemon WebSocket bootstrap `hello` as binary `BudEnvelope`
- [x] Remove active terminal/control dependence on `LegacyJsonPayload` or typed `frame_json`, or document exact blockers
- [x] Reject post-negotiation legacy JSON WebSocket frames from new daemons
- [x] Return typed `UNSUPPORTED_PAYLOAD` errors for unknown envelope payload fields
- [x] Add terminal envelope conformance coverage
- [x] Add WebSocket-only real-daemon terminal smoke with gRPC disabled
- [x] Update old HTTP/2-first wording where it describes forward work
- [x] Define carrier contract in implementation docs and protocol docs
- [x] Document one default control+data WebSocket plus optional future data-only WebSocket
- [x] Update PR notes to say "protobuf semantics over swappable transports"
- [x] Mark file viewer and web proxy productization as blocked on terminal-over-envelope plus later WebSocket-only stream smokes

## Phase 1: Carrier-Neutral Data-Plane Runtime

- [x] Introduce `DataPlane*` service runtime types
- [x] Put existing HTTP/2 data implementation behind an adapter
- [x] Add stream-family capability selection
- [x] Replace file readiness gRPC-only checks
- [x] Replace proxy readiness gRPC-only checks
- [x] Replace public `GRPC_DATA_UNAVAILABLE` file/proxy errors with carrier-neutral errors
- [x] Add selector tests
- [x] Update affected specs

## Phase 2: WebSocket Stream Carrier

- [x] Add explicit WebSocket stream-frame capability negotiation
- [x] Register authenticated default WebSocket as control+data capable
- [x] Keep registry compatible with optional future data-only WebSocket
- [x] Dispatch `stream_data` from WebSocket into runtime streams
- [x] Dispatch `stream_credit` from WebSocket
- [x] Dispatch `stream_reset` from WebSocket
- [x] Dispatch `stream_close` from WebSocket
- [x] Dispatch `file_open_result` from WebSocket
- [x] Dispatch `proxy_open_result` from WebSocket
- [x] Add WebSocket-only stream-carrier validation with gRPC disabled
- [x] Update affected specs

## Phase 3: File Stream Over WebSocket

- [x] Make daemon file capability carrier-based
- [x] Send `file_open` through selected control carrier
- [x] Stream file stat/read/range over WebSocket data carrier
- [x] Preserve daemon local file policy
- [x] Add file route ownership/non-owner tests or record them as Phase 5 blockers
- [x] Add WebSocket-only real-daemon file smoke
- [x] Update affected specs

## Phase 4: Web Proxy Stream Over WebSocket

- [x] Make daemon proxy capability carrier-based
- [x] Send `proxy_open` through selected control carrier
- [x] Stream loopback proxy GET/HEAD over WebSocket data carrier
- [x] Preserve daemon local proxy policy
- [x] Add proxy route ownership/non-owner tests or record them as Phase 5 blockers
- [x] Add WebSocket-only real-daemon proxy smoke
- [x] Update affected specs

## Phase 5: Productization Handoff And Hardening

- [x] Define and enforce WebSocket file/proxy limits
- [x] Add operator configuration for WebSocket stream limits
- [x] Add missing audit coverage for deny/reset/close paths
- [x] Validate file/proxy ownership and non-owner behavior
- [x] Update file viewer design for WebSocket baseline
- [x] Update web proxy design for WebSocket baseline
- [x] Produce product handoff notes
- [x] Decide file viewer vs web proxy implementation order

## Phase 6: Landing Correctness And Fallback Policy

- [x] Define explicit carrier preference/fallback policy
- [x] Align control and data selectors on the same policy vocabulary
- [x] Add WebSocket-baseline and hosted/advanced carrier selection tests
- [x] Implement daemon gRPC-to-WebSocket fallback or document gRPC-only mode
- [x] Validate `stream_close.final_offset` against accepted runtime bytes
- [x] Reset streams instead of closing cleanly on final-offset mismatch
- [x] Wrap file/proxy open sends and clean durable rows on thrown send failures
- [x] Clean durable rows when a daemon accepts open without required status metadata
- [x] Fix or buffer the `hello_ack` before registration race
- [x] Remove, dev-gate, or owner-assign legacy token enrollment
- [x] Update affected specs and protocol docs

## Phase 7: Protobuf Layer Cleanup

- [x] Inventory all `frame_json` and `LegacyJsonPayload` usage
- [x] Decide generated vs. manual WebSocket codec strategy
- [x] Add conformance fixtures for active baseline and data-plane lifecycle payloads
- [x] Remove whole-frame `frame_json` from core stream lifecycle frames or record blockers
- [x] Bound any remaining `frame_json` bridge with explicit carrier/version/removal gates
- [x] Audit JavaScript `uint64` decoding and reject or safely represent unsafe values
- [x] Update protobuf, protocol, service, and daemon specs

## Phase 8: Optional Transport Upgrades

- [x] Keep HTTP/2 gRPC behind carrier-neutral adapters
- [x] Reuse Phase 6 carrier preference policy for hosted deployments
- [x] Add carrier health/fallback tests
- [x] Finalize QUIC token-binding design
- [ ] Implement QUIC data adapter when approved
- [x] Validate forced carrier failures at selector/router level
- [x] Update deployment docs and specs
