# Phase 7: Protobuf Layer Cleanup

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Review Doc**: [../../review/network-upgrade/current-branch-review.md](../../review/network-upgrade/current-branch-review.md)
**Status**: Planned
**Priority**: High

---

## Objective

Reduce the transitional protobuf layer debt left by the transport pivot.

The branch now has a canonical `.proto`, but active runtime code still has hand-written WebSocket codecs and many optional carrier payloads use typed oneof wrappers containing whole-frame `frame_json`. This phase should make the protocol layer feel intentional: clear source of truth, conformance coverage, safe integer handling, and a bounded plan for any compatibility bridge that remains.

## Scope

### In Scope

- inventory all `frame_json` and `LegacyJsonPayload` usage
- decide generated bindings vs. retained manual codecs for WebSocket envelopes
- remove whole-frame `frame_json` from core stream lifecycle frames where practical
- add conformance fixtures for active payload families
- align service and daemon behavior for unknown payloads and unsupported payloads
- decide and enforce safe handling for protobuf `uint64` values in JavaScript
- keep gRPC dynamic/proto-loader shapes isolated behind adapters
- document any compatibility bridge that intentionally remains

### Out Of Scope

- file viewer UI or web proxy productization
- QUIC implementation
- broad schema redesign unrelated to active daemon-service payloads
- changing browser/mobile REST/SSE contracts

## Cleanup Order

1. **Inventory and classify**:
   - active WebSocket baseline payloads
   - optional gRPC adapter payloads
   - core stream lifecycle payloads
   - file/proxy foundation payloads that should be cleaned before productization
   - fixture-only legacy payloads
2. **Stabilize core data-plane lifecycle**:
   - `stream_data`
   - `stream_credit`
   - `stream_reset`
   - `stream_close`
3. **Clean product-adjacent foundations before exposure**:
   - `file_open`
   - `file_open_result`
   - `proxy_open`
   - `proxy_open_result`
4. **Retire or document legacy bridges**:
   - `LegacyJsonPayload`
   - typed payload `frame_json`
   - hand-written codec paths

File/proxy product UI remains future work. This phase may clean their protocol payloads because those payloads are already part of the transport foundation, but it should not add user-facing file or web-serving behavior.

## Implementation Tasks

### Task 1: Protocol Debt Inventory

Produce a short inventory in this phase doc or a linked debug note:

- every `.proto` message that still has `frame_json`
- every service encode/decode branch that emits or accepts `frame_json`
- every daemon encode/decode branch that emits or accepts `frame_json`
- every active test fixture that depends on legacy JSON
- payloads that are active baseline vs. optional adapter vs. fixture-only

### Task 2: Decide Codec Strategy

Choose one of:

- generated protobuf bindings for both service and daemon WebSocket envelopes
- generated bindings for gRPC plus a consciously retained manual WebSocket codec
- retained manual codecs with stronger conformance tests and explicit ownership

The decision should explain why the chosen strategy is better for local builds, CI, and contributor ergonomics.

### Task 3: Add Conformance Fixtures

Add or extend fixtures so Rust and TypeScript both prove the same bytes and JSON-shaped boundary behavior for:

- hello/challenge/proof/ack
- heartbeat
- terminal ensure/status/send/result/observe/output
- reconnect report/decision
- stream data/credit/reset/close
- file/proxy open/result if their payload fields remain in this branch
- unknown fields
- unsupported payload fields

### Task 4: Remove `frame_json` From Core Stream Lifecycle

Move core stream lifecycle frames to field-level payload mapping.

This should happen before optional carriers or future QUIC carry high-volume product traffic.

### Task 5: Bound Remaining `frame_json`

If some payloads keep `frame_json`, make that explicit:

- why it remains
- which carriers can emit it
- which daemons can accept it
- removal gate
- test coverage that prevents it from leaking into active WebSocket terminal/control traffic

### Task 6: Handle `uint64` Safely In JavaScript

Audit `uint64` fields decoded to JavaScript `number`.

For each field:

- define whether it is bounded below `Number.MAX_SAFE_INTEGER`
- reject unsafe values at decode/validation boundaries
- or represent it as `bigint` / string internally where unbounded

At minimum cover stream byte offsets, terminal byte offsets, file sizes/ranges, and timeout/counter fields.

### Task 7: Update Protocol Docs

Update `docs/proto.md` to describe:

- active payload encoding
- compatibility-only payload encoding
- generated/manual codec decision
- `uint64` safety rules
- removal gate for legacy JSON and `frame_json`

## Acceptance Criteria

- [x] Active payload families are classified by encoding strategy.
- [x] The chosen generated/manual codec strategy is documented.
- [x] Core stream lifecycle frames no longer require whole-frame `frame_json`, or a concrete blocker is recorded.
- [x] Shared fixtures cover active baseline and data-plane lifecycle payloads.
- [x] JavaScript `uint64` handling rejects or safely represents unsafe values.
- [x] `LegacyJsonPayload` is fixture-only or explicitly feature-gated.
- [x] Protocol docs match the actual codec behavior.

## Specs To Update

- [x] [../../proto/proto.spec.md](../../proto/proto.spec.md)
- [x] [../../proto/bud/v1/v1.spec.md](../../proto/bud/v1/v1.spec.md)
- [x] [../../docs/proto.md](../../docs/proto.md)
- [x] [../../service/src/proto/proto.spec.md](../../service/src/proto/proto.spec.md)
- [x] [../../service/src/grpc/grpc.spec.md](../../service/src/grpc/grpc.spec.md)
- [x] [../../bud/src/src.spec.md](../../bud/src/src.spec.md)
