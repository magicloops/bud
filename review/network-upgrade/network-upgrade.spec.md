# network-upgrade

Current network-upgrade branch review notes.

## Purpose

Collects review artifacts for the active network-upgrade branch after the branch pivoted from HTTP/2-gRPC/QUIC migration toward a WebSocket-baseline, transport-independent protocol foundation.

This folder is current review material, while the older top-level network-upgrade review files remain historical analysis snapshots.

## Files

### `current-branch-review.md`

Comprehensive review of the current `network-upgrade` branch compared to `origin/main`.

Coverage:

- branch shape and prior review status
- transport selection and fallback policy gaps
- data-plane correctness findings
- file/proxy edge-stream cleanup gaps
- protocol codec and `frame_json` debt
- daemon file/proxy performance concerns
- stale plan/doc cleanup
- open questions and recommended landing gate
- closure status for the landing-gate items resolved or intentionally deferred by the swappable-transport implementation phases

### `cleanup-checklist.md`

Action-oriented cleanup list for landing the branch cleanly.

Coverage:

- files and folders to keep as forward architecture
- historical plan/review docs to consolidate
- rename candidates from the old migration framing
- implementation cleanup before merge
- productization follow-ups
- spike/reference retention decision
- explicit done/deferred status for PR landing cleanup

## Dependencies

- [../network-upgrade.md](../network-upgrade.md) - historical HTTP/2-first network upgrade review
- [../network-upgrade-websocket-first-pr-review.md](../network-upgrade-websocket-first-pr-review.md) - prior WebSocket-first PR review
- [../../plan/swappable-transport/swappable-transport.spec.md](../../plan/swappable-transport/swappable-transport.spec.md) - forward WebSocket-baseline implementation plan
- [../../plan/network-upgrade/network-upgrade.spec.md](../../plan/network-upgrade/network-upgrade.spec.md) - older HTTP/2-first plan tree retained as historical context
- [../../docs/proto.md](../../docs/proto.md) - current daemon-service wire protocol
- [../../proto/bud/v1/bud.proto](../../proto/bud/v1/bud.proto) - shared daemon protocol schema

## TODOs / Technical Debt

None at this review-folder level. Remaining transport/product follow-ups are tracked in [../../plan/swappable-transport/validation-checklist.md](../../plan/swappable-transport/validation-checklist.md), [../../design/network-upgrade-file-serving-productization.md](../../design/network-upgrade-file-serving-productization.md), [../../design/network-upgrade-web-serving-productization.md](../../design/network-upgrade-web-serving-productization.md), and [../../design/network-upgrade-quic-transport.md](../../design/network-upgrade-quic-transport.md).

---

*Referenced by: [../review.spec.md](../review.spec.md)*
