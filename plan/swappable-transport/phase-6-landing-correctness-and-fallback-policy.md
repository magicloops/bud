# Phase 6: Landing Correctness And Fallback Policy

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Review Doc**: [../../review/network-upgrade/current-branch-review.md](../../review/network-upgrade/current-branch-review.md)
**Status**: Planned
**Priority**: Urgent

---

## Objective

Close the correctness and policy gaps that remain after the WebSocket-baseline stream foundation work, without turning this phase into file viewer or web proxy productization.

This phase should make the branch land cleanly: one explicit carrier policy, deterministic durable state cleanup on transport failures, no ownerless production Bud enrollment path, and no handshake race where the daemon can send post-auth frames before service-side registration is ready.

## Scope

### In Scope

- carrier preference and fallback policy for control and data carriers
- daemon behavior when gRPC URLs are configured but gRPC connection fails
- service-side carrier selection tests for WebSocket baseline and optional carrier preference
- `stream_close.final_offset` validation against accepted runtime bytes
- deterministic file/proxy open cleanup when the selected carrier send throws or refuses work
- deterministic cleanup when daemon accepts an open result without required status metadata
- WebSocket and gRPC handshake registration ordering
- enrollment-token bootstrap decision and ownerless Bud prevention
- focused tests for the failure paths above

### Out Of Scope

- file viewer UI or user file-open flows
- localhost web-serving product UX
- QUIC implementation
- generated protobuf binding migration
- daemon file streaming performance work
- broad carrier health scoring beyond the policy hooks needed here

## Fixed Decisions To Record

- WebSocket remains the mandatory open-source baseline carrier.
- Optional HTTP/2 gRPC carriers must not be required for local correctness.
- Product routes must not branch on transport type.
- Any hosted preference for HTTP/2 or future QUIC must be an explicit operator policy, not an implicit side effect of which sessions happen to be connected.
- A signed-in user must not be able to create or use browser-visible resources for an ownerless Bud.

## Implementation Tasks

### Task 1: Define Carrier Policy

Add a single policy shape that both control and data selection can consume.

At minimum define:

- default open-source policy: WebSocket baseline
- optional hosted policy: prefer configured advanced carriers only when healthy
- fallback ordering
- behavior when an advanced carrier is configured but unavailable
- what gets logged/audited when fallback happens

The policy should answer:

- Does gRPC control being configured disable WebSocket, or can the daemon fall back?
- Should `h2_grpc` control imply `h2_data` data preference?
- Is WebSocket data preferred over `h2_data` for local installs?
- How will future QUIC enter the selector without changing product routes?

### Task 2: Align Control And Data Selection

Update service selectors so control and data use the same policy vocabulary.

Tests should cover:

- WebSocket-only daemon selects WebSocket for control and data.
- WebSocket plus `h2_data` under baseline policy still selects WebSocket if that is the configured default.
- Hosted/advanced policy can prefer `h2_data` when available.
- Refused or unavailable advanced carriers fall back according to policy and report why.

### Task 3: Clarify Daemon gRPC Fallback

Choose one:

- add daemon fallback from failed `BUD_GRPC_CONTROL_URL` connection to `BUD_SERVER_URL`
- or document that setting `BUD_GRPC_CONTROL_URL` deliberately selects gRPC-only daemon mode

If fallback is implemented, make it visible in logs and avoid enrollment/identity loops.

### Task 4: Validate Stream Close Offsets

Make `stream_close.final_offset` authoritative only when it matches the runtime stream's accepted receive offset.

On mismatch:

- send or record `stream_reset` with `protocol_error`
- transition durable `bud_stream` to `reset`
- avoid marking the operation succeeded
- emit audit/log context with expected and reported offsets

### Task 5: Harden Open Send Failure Cleanup

Wrap file/proxy open-frame sends in deterministic cleanup logic.

For carrier send exception or refused send:

- unregister runtime stream
- clear session `activeStreamId`
- transition stream to `reset`
- transition operation to `rejected` or `failed`
- append an audit event
- return deterministic `424 DATA_PLANE_UNAVAILABLE`

### Task 6: Harden Invalid Accepted Results

If daemon returns `accepted: true` without required status metadata:

- treat it as `protocol_error`
- send a remote reset when possible
- transition durable stream and operation out of `opening` / `offered`
- append audit
- return deterministic 502 to the browser caller

### Task 7: Register Before Ack Or Buffer Early Frames

Fix the `hello_ack` ordering race in both WebSocket and gRPC gateways.

Acceptable approaches:

- register state, durable sessions, and trackers before sending `hello_ack`
- or buffer post-auth inbound frames until registration is complete

Tests should inject an immediate `reconnect_report` after ack and assert service-side session ids are available.

### Task 8: Remove Or Quarantine Ownerless Token Enrollment

Decide the legacy token bootstrap story.

Preferred cleanup:

- browser-mediated claim is the production path
- legacy token enrollment is removed or dev-only
- dev-only token enrollment cannot create browser-visible ownerless Buds

If retained:

- require a follow-up claim/owner assignment before the Bud appears in user-scoped inventory or file/proxy routes
- update docs and tests to prove non-owner behavior remains `404`

## Acceptance Criteria

- [x] The active docs describe one carrier policy and no longer imply separate control/data preference rules.
- [x] Service tests cover WebSocket-baseline and advanced-carrier selection.
- [x] Daemon fallback behavior is implemented or explicitly documented.
- [x] `stream_close.final_offset` mismatch resets instead of closing cleanly.
- [x] file/proxy open send exceptions and refused sends leave no dangling durable rows.
- [x] invalid accepted file/proxy results leave no dangling durable rows.
- [x] handshake registration race is fixed or covered by buffering.
- [x] legacy ownerless token enrollment is removed, dev-only, or forced through owner assignment.

## Specs To Update

- [x] [../../docs/proto.md](../../docs/proto.md)
- [x] [../../service/src/transport/transport.spec.md](../../service/src/transport/transport.spec.md)
- [x] [../../service/src/ws/ws.spec.md](../../service/src/ws/ws.spec.md)
- [x] [../../service/src/grpc/grpc.spec.md](../../service/src/grpc/grpc.spec.md)
- [x] [../../service/src/files/files.spec.md](../../service/src/files/files.spec.md)
- [x] [../../service/src/proxy/proxy.spec.md](../../service/src/proxy/proxy.spec.md)
- [x] [../../bud/src/src.spec.md](../../bud/src/src.spec.md)
