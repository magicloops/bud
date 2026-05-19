# Clean Close Reconnect Progress Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet started
- `[x]` implemented or documentation updated
- `[-]` deferred or intentionally out of scope for now

Runtime verification lives in [validation-checklist.md](./validation-checklist.md).

## Phase 1: Nonblocking WebSocket Session Teardown

- [x] WebSocket shutdown helper exists in `bud/src/app.rs`
- [x] heartbeat send failure uses the helper
- [x] Pong send failure uses the helper
- [x] WebSocket close frame uses the helper
- [x] WebSocket read error uses the helper
- [x] WebSocket stream `None` uses the helper
- [x] writer task is aborted or time-bound after read-side close/error
- [x] shutdown start/completion logs exist

## Phase 2: Proxy/File Disconnect Cancellation

- [x] `ProxyManager` exposes transport-disconnect cleanup
- [x] proxy HTTP streams receive reset on disconnect cleanup
- [x] proxy WebSocket sessions receive close/error on disconnect cleanup
- [x] proxy WebSocket loop exits when its event channel closes
- [x] proxy cleanup logs canceled stream/session counts
- [x] `FileManager` exposes transport-disconnect cleanup
- [x] file streams receive reset on disconnect cleanup
- [x] file cleanup logs canceled stream counts
- [x] WebSocket shutdown calls proxy/file cleanup
- [x] gRPC shutdown reuses proxy/file cleanup where applicable

## Phase 3: Regression Tests And Validation

- [x] session teardown test covers close with a live cloned sender
- [x] proxy HTTP disconnect cleanup test added
- [x] proxy WebSocket disconnect cleanup test added
- [x] file disconnect cleanup test added
- [x] daemon cargo tests pass
- [x] local HTTPS sleep/resume validation completed
- [ ] direct WebSocket reconnect validation completed
- [x] affected daemon specs updated

## Overall Progress

| Phase | Status | Notes |
| --- | --- | --- |
| 1 | Implemented | WebSocket shutdown now aborts the writer task and returns to reconnect without waiting on old sender clones |
| 2 | Implemented | Proxy/file managers cancel active transport-bound tasks during daemon transport shutdown |
| 3 | HTTPS validation complete | User validated macOS sleep/resume and Caddy process termination; direct `ws://localhost:3000/ws` forced-close validation remains optional |

## Notes

- Keep this checklist current as soon as implementation or verification status
  changes.
- If a build/run command fails, capture the exact command and error output and
  stop for human guidance.
- 2026-05-19: User validated the local HTTPS path with macOS sleep/resume and
  killing the Caddy process; reconnect behavior worked as expected.
