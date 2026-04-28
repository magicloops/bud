# Phase 3: File Stream Over WebSocket

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Implemented and validated
**Priority**: High

---

## Objective

Make the existing file session foundation work over the WebSocket baseline with gRPC disabled.

This is not the full file viewer product. It proves the daemon-service file stream contract that the product can later use.

## Current Problem

Phase 1/2 are responsible for the carrier-neutral selector, WebSocket carrier registration, daemon stream-frame capability advertisement, and selected-carrier `file_open` routing.

This phase should assume those prerequisites exist and prove the end-to-end file stream path with gRPC disabled. The remaining risk is integration: browser file edge request → WebSocket `file_open` → daemon local file policy → WebSocket `stream_data`/`stream_close` → HTTP response.

## Target Behavior

With only WebSocket enabled:

- the daemon advertises `files.workspace_read` when the WebSocket carrier supports binary envelope stream frames
- the service creates file sessions after browser ownership checks
- the service selects an active control carrier to send `file_open`
- the service selects an active data carrier that supports `file_read`
- the daemon enforces local file policy
- stat/read/range bytes stream back over WebSocket stream frames
- resets and closes propagate to the service file edge

## Implementation Steps

1. Confirm daemon file capability gating uses carrier stream support.
2. Confirm file session readiness uses the carrier-neutral data-plane selector.
3. Confirm `file_open` uses the selected carrier route.
4. Confirm `file_open_result` from WebSocket dispatch reaches the file runtime.
5. Confirm `stream_data`, `stream_reset`, and `stream_close` reach active file edge streams.
6. Keep existing local file policy:
   - read-only
   - approved roots
   - regular files only
   - symlink rejection
   - range and max-byte limits
   - stale content identity rejection when available
7. Add WebSocket-only real-daemon file smoke coverage.

## Acceptance Criteria

- [x] File session readiness succeeds for a capable WebSocket-only daemon.
- [x] File session readiness fails with carrier-neutral errors when no data carrier exists.
- [x] `file_open` is no longer gRPC-router-only.
- [x] File stat/read/range smoke passes with gRPC disabled.
- [x] Stream closes reach file callers.
- [x] Existing HTTP/2 file smoke, if retained, still passes through the same runtime boundary.

## Validation

- Unit tests:
  - file readiness with WebSocket carrier
  - file readiness without file stream-family support
  - non-owner access remains denied before stream open
  - daemon denial maps to typed file result
- Real-daemon smoke:
  - create a temporary workspace file
  - create file session as the owner
  - open/read full file over WebSocket
  - read a bounded range
  - force gRPC disabled

Completed validation:

- `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/transport/data-plane-router.test.ts src/files/file-session.test.ts src/proxy/proxy-session.test.ts src/ws/bud-connection.test.ts`
- `pnpm --dir /Users/adam/bud/service build`
- `pnpm --dir /Users/adam/bud/service smoke:ws-file`

## Specs To Update

- [x] [../../service/src/files/files.spec.md](../../service/src/files/files.spec.md)
- [x] [../../service/src/transport/transport.spec.md](../../service/src/transport/transport.spec.md)
- [x] [../../service/src/ws/ws.spec.md](../../service/src/ws/ws.spec.md)
- [x] [../../bud/src/src.spec.md](../../bud/src/src.spec.md)
- [x] [../../docs/proto.md](../../docs/proto.md)
- [x] [../../service/src/scripts/scripts.spec.md](../../service/src/scripts/scripts.spec.md)

## Non-Goals

- Frontend file viewer UI.
- Agent-side file access.
- Arbitrary file browsing.
- File writes.
- QUIC file transport.
