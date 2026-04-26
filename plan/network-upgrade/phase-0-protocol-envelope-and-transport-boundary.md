# Phase 0: Protocol Envelope And Transport Boundary

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: In progress - protobuf envelope carrier and typed payload dispatch implemented

---

## Objective

Make the existing daemon-service behavior transport-independent without changing deployment topology. This phase defines protobuf messages, carries them over the current WebSocket path, and splits service/daemon runtime code away from WebSocket-specific senders.

## Context

Today, WebSocket JSON frames are both the protocol and the transport. If HTTP/2 gRPC, HTTP/2 data, QUIC, and fallback WebSocket each define their own payload shape, every future feature will multiply security and compatibility work. The first move is to define the common envelope and use WebSocket as only one carrier.

## Scope

### In Scope

- protobuf schema for `BudEnvelope v1`
- typed payloads for the currently used daemon frames
- typed `BudError` with stable codes and retry hints
- conformance fixtures for encode/decode and compatibility behavior
- service daemon-transport router interface
- daemon transport client interface
- WebSocket carrier for the new envelope
- bounded terminal output chunks in the daemon output watcher
- docs/spec updates for the envelope and compatibility mode

### Out Of Scope

- HTTP/2 gRPC server/client implementation
- QUIC implementation
- proxy/file product features
- broad database lifecycle state
- device keypair auth migration, except message fields reserved for it

## Fixed Decisions

- The new envelope is protobuf-first.
- WebSocket compatibility carries the same envelope rather than a separate JSON-only protocol.
- JSON parsing may remain temporarily for current daemons during rollout, but canonical code paths should emit the protobuf envelope.
- The envelope includes QUIC-shaped fields now, but no QUIC code ships in this phase.
- Unknown fields and unsupported payloads must be tolerated and surfaced through typed errors.
- Terminal output chunks should be capped to the documented maximum target before later stream work depends on it.

## Implementation Tasks

### Task 1: Choose and wire protobuf tooling

Decide the code generation path for:

- Rust daemon
- Node service
- shared fixtures

Recommended evaluation:

- Rust: `prost` with build-time generation
- Service: Buf/Connect generated TypeScript or a comparable protobuf runtime that does not force gRPC server choice yet
- Fixtures: checked-in binary and JSON text-format examples if practical

Keep this task small: choose the generator, add minimal build wiring, and document why it was chosen.

Implementation note: the first carrier slice uses a checked-in `.proto` schema plus small in-repo Rust/TypeScript protobuf wire codecs for `BudEnvelope` compatibility frames. This avoids adding `protoc`/generated-code dependencies before the HTTP/2 gRPC stack decision, while still putting real protobuf envelope bytes on the WebSocket compatibility path. Generated protobuf types remain the intended replacement once Phase 2 validates the final gRPC/tooling stack.

Current implementation note: known frames now dispatch through typed oneof payload fields in the in-repo codecs. The payload messages carry a transitional `frame_json` field so existing JSON-shaped handlers can keep running until generated field-level protobuf structs replace the bridge.

### Task 2: Define `BudEnvelope v1`

Add schema for:

- envelope metadata
- payload `oneof`
- traffic class enum
- transport kind enum
- stream type enum
- operation state enum
- stream reset reason enum
- typed error payload

Initial payload coverage:

- hello / hello acknowledgement / challenge / proof
- heartbeat / heartbeat acknowledgement
- terminal ensure / status
- terminal send / send result
- terminal observe / observe result
- terminal output
- terminal input acknowledgement or error where needed
- legacy run payloads only if active code still routes them

### Task 3: Add conformance fixtures

Fixtures should cover:

- current terminal happy path
- reconnect hello/auth path
- unknown envelope field tolerance
- unsupported payload handling
- invalid version handling
- typed error mapping
- terminal output chunk sequencing

These fixtures should be usable by both Rust and TypeScript tests.

### Task 4: Introduce service transport router interface

Create a service-side boundary such as `DaemonTransportRouter` that owns:

- connection lookup by Bud ID
- send control envelope
- open stream or reject unsupported stream type
- transport health metadata
- fallback selection placeholder

Update terminal runtime code so it depends on this interface, not direct `sendFrameToBud(...)` imports.

### Task 5: Introduce daemon transport client interface

Create a daemon-side boundary for:

- sending control events
- sending data frames
- reporting liveness/transport health
- reconnect lifecycle callbacks

Update terminal/run modules so they do not know the sender is a WebSocket sink.

### Task 6: Implement WebSocket envelope carrier

Update current WebSocket paths to:

- send canonical protobuf envelopes for new code paths
- optionally accept legacy JSON during rollout
- map legacy JSON into typed payloads at the boundary
- keep authentication and terminal behavior unchanged

### Task 7: Bound terminal output chunks

Update the daemon output watcher so emitted chunks respect the maximum chunk size. Preserve `seq` and `byte_offset` semantics.

### Task 8: Update docs and specs

Update:

- `docs/proto.md`
- Bud daemon specs for new transport/protocol modules
- service specs for new transport/protocol modules
- root spec references as needed
- this plan checklist as work completes

## Files Likely Affected

### Bud

- `bud/Cargo.toml`
- `bud/build.rs`
- `bud/src/protocol.rs`
- `bud/src/app.rs`
- `bud/src/run.rs`
- `bud/src/terminal/mod.rs`
- `bud/src/terminal/tmux.rs`
- new `bud/src/transport/`

### Service

- `service/package.json`
- `service/src/ws/`
- `service/src/runtime/terminal/request-dispatcher.ts`
- `service/src/runtime/terminal-session-manager.ts`
- new `service/src/proto/`
- new `service/src/transport/`

### Docs

- `docs/proto.md`
- affected spec files

## Test Plan

- Rust protobuf encode/decode unit tests
- TypeScript protobuf encode/decode unit tests
- cross-language fixture conformance tests
- service terminal request-dispatch tests using transport router mock
- daemon terminal output chunking tests
- WebSocket integration smoke test for current terminal flow

## Exit Criteria

- canonical protobuf envelope exists and is tested in service and daemon
- current terminal behavior works over WebSocket envelope carrier
- terminal runtime no longer imports direct WebSocket send helpers
- daemon runtime modules no longer depend on WebSocket sender types
- terminal output chunks are bounded
- `docs/proto.md` describes the envelope, payloads, errors, and compatibility path
