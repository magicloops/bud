# Validation Checklist: Swappable Transport

## Baseline Setup

- [x] Service starts with gRPC disabled.
- [x] Daemon starts with no `BUD_GRPC_CONTROL_URL` or gRPC data URL.
- [x] Daemon connects through `/ws`.
- [x] WebSocket hello advertises binary `BudEnvelope` support.
- [x] Daemon WebSocket bootstrap `hello` is sent as binary `BudEnvelope`.
- [x] Service records or logs the default WebSocket carrier as control+data capable.
- [x] Carrier/session model can also represent a future data-only WebSocket.

## Protocol And Carrier Semantics

- [x] WebSocket carries protobuf envelopes, not JSON-only frames, for new stream behavior.
- [x] Existing terminal/control traffic carries binary `BudEnvelope` over WebSocket.
- [x] Active terminal/control payloads use typed protobuf fields rather than whole-frame `frame_json`, unless Phase 0 records a concrete blocker.
- [x] `LegacyJsonPayload` is absent from the active terminal/control happy path, unless a deliberate rollback flag is enabled.
- [x] Post-negotiation legacy JSON WebSocket frames are rejected with a protocol error instead of compatibility fallback.
- [x] Unknown envelope payloads fail with typed unsupported-payload behavior.
- [x] Focused gateway tests confirm outbound terminal directives use binary `BudEnvelope` typed payload fields.
- [ ] Stream IDs are unique for concurrent file/proxy sessions.
- [ ] `stream_data` sequence numbers are monotonic per stream.
- [x] `stream_credit` changes in-flight byte availability.
- [x] `stream_reset` reaches the waiting route/runtime caller.
- [x] `stream_close` reaches the waiting route/runtime caller.
- [x] Carrier selection logs or returns the selected transport kind.

## Terminal Smoke

- [x] Create or attach a thread-scoped terminal session over WebSocket-only daemon connection.
- [x] Send terminal input.
- [x] Receive terminal output.
- [x] Validate reconnect reconciliation over WebSocket-only daemon connection.
- [ ] Confirm existing browser REST/SSE behavior is unchanged.
- [x] Confirm gRPC-disabled terminal smoke passes.
- [ ] Confirm captured terminal traffic uses binary `BudEnvelope` payloads.
- [x] Confirm terminal traffic does not use whole-frame `frame_json`, unless Phase 0 documents a temporary blocker.

## File Smoke

- [x] Create a test file under an approved daemon workspace/root.
- [x] Create a file session as the owning browser user.
- [x] Read the full file over WebSocket stream frames.
- [x] Read a bounded byte range over WebSocket stream frames.
- [ ] Reject a path outside the approved root.
- [ ] Reject a symlink or non-regular file.
- [ ] Reject over-limit reads.
- [ ] Propagate daemon file denial as a typed error.
- [x] Confirm gRPC-disabled file smoke passes.

## Proxy Smoke

- [x] Start a local HTTP server on `127.0.0.1`.
- [x] Create a proxy session as the owning browser user.
- [x] Proxy a `GET` response over WebSocket stream frames.
- [x] Proxy a `HEAD` response over WebSocket stream frames.
- [ ] Reject a non-loopback target.
- [ ] Reject unsupported methods.
- [ ] Enforce response byte limits.
- [ ] Propagate daemon proxy denial as a typed error.
- [x] Confirm gRPC-disabled proxy smoke passes.

## Ownership And Auth

- [x] Unauthenticated file session create/open returns `401`.
- [x] Unauthenticated proxy session create/open returns `401`.
- [x] Signed-in non-owner file access returns `404`.
- [x] Signed-in non-owner proxy access returns `404`.
- [x] Stream edge endpoints authorize before attaching runtime listeners.
- [x] SQL reads filter by owner rather than filtering in memory.

## Limits And Backpressure

- [x] WebSocket max frame bytes are enforced.
- [x] WebSocket max in-flight bytes are enforced.
- [x] File max session bytes are enforced.
- [x] Proxy max response bytes are enforced.
- [x] Concurrent stream limits are enforced.
- [x] Idle timeout closes streams with a typed reason.
- [x] Absolute stream TTL closes streams with a typed reason.

## Optional Carrier Parity

- [ ] Existing HTTP/2 gRPC terminal smoke still passes when enabled.
- [x] Existing HTTP/2 file smoke still passes when enabled.
- [x] Existing HTTP/2 proxy smoke still passes when enabled.
- [ ] Forced HTTP/2 failure does not break WebSocket baseline.
- [ ] QUIC, when implemented, carries the same envelope and stream lifecycle.
- [ ] Forced QUIC failure falls back according to carrier policy.

## Documentation

- [x] `docs/proto.md` describes WebSocket as the baseline carrier for protobuf envelopes.
- [x] Service transport/runtime specs describe carrier-neutral data-plane abstractions.
- [x] WebSocket spec describes stream-frame dispatch.
- [x] File/proxy specs describe WebSocket-first readiness.
- [x] Product design docs avoid HTTP/2 or QUIC requirements.
