# Cleanup Checklist: Network Upgrade Branch

Date: 2026-04-28

This checklist turns the current branch review into concrete cleanup decisions. It is not a replacement for the implementation plan; it is a landing hygiene pass for the branch after the pivot back to a WebSocket baseline.

## Keep As Forward Architecture

- `proto/bud/v1/bud.proto`: shared schema for the logical daemon protocol.
- `docs/proto.md`: current wire contract, after stale HTTP/2-first language is removed.
- `plan/swappable-transport/`: forward implementation plan for WebSocket baseline plus optional carriers.
- `design/network-upgrade-websocket-fallback.md`: keep only if its baseline-carrier contents remain clear despite the filename, or rename it.
- `design/network-upgrade-quic-transport.md`: follow-on optional carrier design.
- `service/src/proto/`: service envelope and WebSocket binary codec, with `frame_json` debt tracked.
- `service/src/transport/`: daemon/control/data-plane router boundary.
- `service/src/ws/`: baseline daemon carrier.
- `service/src/grpc/`: optional HTTP/2 adapter, if clearly documented as optional.
- `service/src/files/` and `service/src/proxy/`: service-owned session and edge-stream foundations.
- `bud/src/transport.rs`: daemon transport-neutral sender boundary.
- `bud/src/files/` and `bud/src/proxy/`: daemon local file/proxy adapters, after productization debt is acknowledged.

## Consolidate Or Mark Historical

- `plan/network-upgrade/implementation-spec.md`
- `plan/network-upgrade/phase-*.md`
- `plan/network-upgrade/progress-checklist.md`
- `plan/network-upgrade/validation-checklist.md`
- `review/network-upgrade.md`
- `review/network-upgrade-websocket-first-pr-review.md`

Recommended action:

- Keep the two review docs as historical analysis.
- Done: `plan/network-upgrade/` is now explicitly historical, with top-of-file superseded banners.
- Done: root spec links now point to `plan/swappable-transport/` as the forward source.

## Rename Candidates

These names still carry the old migration framing:

- `design/network-upgrade-websocket-fallback.md`
- `plan/network-upgrade/`
- `review/network-upgrade.md`

Possible replacements:

- `design/network-upgrade-websocket-baseline.md`
- `plan/swappable-transport/` already exists and can remain the canonical forward plan.
- Keep old review filenames because they represent what was reviewed at that time.

Renaming is optional, but if files keep old names they should have a clear top-level note explaining whether they are current or historical.

## Implementation Cleanup Before Merge

- Done: carrier preference/fallback policy is centralized across control and data routing, with WebSocket-baseline and optional-carrier preference tests.
- Done: daemon gRPC/WebSocket mode behavior is covered at the router/selector level, and the existing HTTP/2 gRPC terminal smoke still passes when enabled.
- Done: `stream_close.final_offset` mismatch resets the stream instead of recording a clean close.
- Done: file/proxy open send failures and accepted-without-status results have foundation cleanup behavior; route-level product edge tests are tracked as future file/proxy productization work.
- Done: file/proxy unavailable status is treated as a transport snapshot returned to callers, not a terminal session row.
- Done: legacy enrollment-token bootstrap is dev-gated/quarantined so it cannot create production-visible ownerless Buds.
- Deferred by design: exhaustive file/proxy route-level edge tests for open timeout, open rejection, invalid accepted result, carrier refusal, carrier throw, concurrent stream ID uniqueness, monotonic stream data, and daemon policy denial are recorded in the file/proxy productization design docs rather than blocking this transport-foundation PR.
- Deferred by design: QUIC runtime implementation and real QUIC smoke validation are follow-on work after the runtime/deployment shape is approved.

## Productization Follow-Ups

- Replace daemon file prebuffering with chunked file reads under stream credit.
- Add broader carrier metrics and operator-facing transport diagnostics beyond the current selected-carrier health/candidate status.
- Revisit file/proxy WebSocket byte caps after product UX requirements are known.
- Remove remaining `frame_json` payloads for stream/proxy/file families.
- Add generated protobuf bindings or keep documenting why manual codecs remain intentional.
- Add full route-level optional-carrier demotion coverage after optional carriers move beyond adapter parity.
- Implement QUIC data adapter and real QUIC smoke validation from the dedicated QUIC design checklist.

## Spike And Reference Decision

The `spikes/grpc-interop/` tree is valuable evidence for choosing `@grpc/grpc-js`, but it is large.

Decision: keep it as a reproducible spike. Its specs already mark it as spike-only and not imported by the production `bud/` or `service/` packages. It can be collapsed into a shorter `reference/` write-up later if branch size becomes a concern, but that is not a merge blocker for this PR.
