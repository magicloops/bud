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

- Add a single carrier policy abstraction used by both control and data routing.
- Add tests for WebSocket-baseline selection and optional HTTP/2 preference if configured.
- Add daemon-side gRPC-to-WebSocket fallback, or document that gRPC env vars opt into a separate mode with no fallback.
- Validate stream close final offsets and reset on mismatch.
- Wrap file/proxy open send in `try/catch` and clean durable rows on exception.
- Reset and transition durable state when a daemon accepts file/proxy open without a status code.
- Decide whether `unavailable` file/proxy sessions are terminal rows or transient transport snapshots.
- Remove or quarantine ownerless token enrollment.
- Add edge-stream tests for open timeout, open rejection, invalid accepted result, carrier refusal, carrier throw, and final-offset mismatch.

## Productization Follow-Ups

- Replace daemon file prebuffering with chunked file reads under stream credit.
- Add carrier metrics and operator-facing transport diagnostics.
- Decide file/proxy WebSocket byte caps for the open-source baseline.
- Remove remaining `frame_json` payloads for stream/proxy/file families.
- Add generated protobuf bindings or document why manual codecs remain intentional.
- Add optional HTTP/2 fallback/demotion tests.
- Add QUIC token binding, health scoring, and fallback only after baseline carrier parity is green.

## Spike And Reference Decision

The `spikes/grpc-interop/` tree is valuable evidence for choosing `@grpc/grpc-js`, but it is large. Before merge, choose one:

- Keep it as a reproducible spike with specs that say it is non-product and not part of normal builds.
- Collapse it into a shorter `reference/` write-up and drop the runnable spike harness.

Either choice is defensible. The current halfway state is acceptable for an internal branch but noisy for a clean landing.
