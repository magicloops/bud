# Phase 5: Productization Handoff And Hardening

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented for current PR foundation; product UI follow-ups remain
**Priority**: High

---

## Objective

Close the safety and product-readiness gaps needed before file viewer and web proxy UI work starts.

This phase does not have to implement the UI. It defines the handoff criteria so product work can build on a stable, carrier-neutral service contract.

## Required Hardening

### Ownership And Authorization

- File session create/open/edge routes authorize the browser viewer before daemon stream open.
- Proxy session create/open/edge routes authorize the browser viewer before daemon stream open.
- Signed-in non-owners get `404`.
- Unauthenticated requests get `401`.
- List/read queries filter by owner in SQL.

Implementation note: Phase 5 added route tests for unauthenticated create/edge requests, signed-in non-owner create/edge requests, and owned session serialization through owner-filtered lookups.

### WebSocket Limits

Define and enforce defaults for baseline WebSocket carriers:

- max concurrent file streams per Bud
- max concurrent proxy streams per Bud
- max bytes per file session
- max bytes per proxy response
- max chunk size
- max in-flight bytes per stream
- idle timeout
- absolute stream TTL

Implementation note: the current PR enforces these as carrier-neutral service limits, so they apply to the WebSocket baseline and optional HTTP/2 data carrier consistently.

### Audit And Observability

Record or expose:

- file session create/revoke
- proxy session create/revoke
- stream open
- daemon denial
- service denial
- stream reset
- stream close
- carrier selected
- carrier unavailable/degraded

Implementation note: `file.stream_open` / `proxy.stream_open` now include selected carrier metadata, service/daemon open denials emit `*.stream_denied`, and generic data-plane reset/close paths emit `data_plane.stream_reset` / `data_plane.stream_close` audit events.

### Product Handoff

File viewer handoff must define:

- how clickable path references are detected or created
- whether sessions are lazy-on-click or pre-created
- markdown/code/text viewer selection rules
- maximum displayable file size
- expired/offline/denied states

Decision: create file sessions lazily on explicit user click for the first product version.

Web proxy handoff must define:

- how users open a local server
- allowed target ports
- route shape for proxied URLs
- header and cookie policy
- asset concurrency behavior
- expired/offline/denied states

Decision: create proxy sessions from explicit user action only. Do not auto-create sessions for every mentioned localhost URL or port.

## Implementation Steps

1. [x] Add or strengthen route tests for file/proxy ownership.
2. [x] Add carrier-neutral WebSocket degraded limits.
3. [x] Add operator configuration for WebSocket file/proxy byte limits.
4. [x] Add missing audit events and stream finalization coverage.
5. [x] Update file viewer and web proxy design docs with the WebSocket-first baseline.
6. [x] Produce handoff notes for UI/product implementation.
7. [x] Decide which hardening items block product UI and which can remain tracked follow-ups.

## Acceptance Criteria

- [x] File/proxy routes have owner, non-owner, and unauthenticated tests.
- [x] WebSocket stream limits are documented and enforced.
- [x] Stream reset/close/denial events are observable enough for local debugging.
- [x] File viewer design is updated to assume WebSocket baseline and optional future carriers.
- [x] Web proxy design is updated to assume WebSocket baseline and optional future carriers.
- [x] Product implementation can proceed without carrier-specific branches.

## Validation

- [x] Run service route tests for auth/ownership.
- [x] Run WebSocket-only file/proxy smokes after doc/spec updates.
- [ ] Manually inspect audit/log output for carrier selection and stream close/reset reasons.
- [x] Review design docs for accidental HTTP/2 or QUIC requirements.

## Specs To Update

- [x] [../../service/src/files/files.spec.md](../../service/src/files/files.spec.md)
- [x] [../../service/src/proxy/proxy.spec.md](../../service/src/proxy/proxy.spec.md)
- [x] [../../service/src/db/db.spec.md](../../service/src/db/db.spec.md) if audit/schema behavior changes
- [x] [../../design/network-upgrade-file-serving-productization.md](../../design/network-upgrade-file-serving-productization.md)
- [x] [../../design/network-upgrade-web-serving-productization.md](../../design/network-upgrade-web-serving-productization.md)
- [x] [../../design/network-upgrade-websocket-fallback.md](../../design/network-upgrade-websocket-fallback.md)

## Open Questions

- File sessions are lazy-on-click for the first product version.
- One authenticated control+data WebSocket remains the default; an optional second data WebSocket is still a future carrier adapter, not a product blocker.
- The current safe default proxy response ceiling is `PROXY_SESSION_MAX_RESPONSE_BYTES=16MiB`.
- File viewer can launch before the web proxy UI because Phase 5 route-auth and stream limits now cover both foundations; each product still needs its own frontend/UX validation.
