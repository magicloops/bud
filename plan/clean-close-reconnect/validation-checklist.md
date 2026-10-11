# Clean Close Reconnect Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Static Validation

- [x] `git diff --check` passes for touched files
- [x] affected daemon specs are updated
- [x] no protocol docs are required because no frame shapes changed
- [x] no database migrations are required

## Automated Validation

- [x] `cargo test --manifest-path /Users/adam/bud/bud/Cargo.toml` passes
- [x] session teardown regression covers close with live sender clone
- [x] proxy HTTP stream disconnect cleanup test passes
- [x] proxy WebSocket disconnect cleanup test passes
- [x] file stream disconnect cleanup test passes
- [x] existing proxy WebSocket echo tests still pass
- [x] existing file read tests still pass

## Local HTTPS Manual Validation

- [x] `pnpm dev:https` starts service, web, and Caddy
- [x] daemon connects with `BUD_SERVER_URL=wss://localhost:3443/ws`
- [x] Web view opens a local app successfully
- [x] Vite/HMR or another local WebSocket proxy session is active
- [x] after sleep/resume, daemon logs `Server closed connection frame=None`
- [x] daemon logs cleanup completion
- [x] daemon logs `Session ended; reconnecting`
- [x] daemon logs a fresh `Connecting to backend`
- [x] daemon logs a fresh `Handshake established`
- [x] service marks the Bud online after reconnect
- [x] terminal input works after reconnect
- [x] Web view recovery/reload works after reconnect

## Direct WebSocket Manual Validation

- [ ] daemon connects with `BUD_SERVER_URL=ws://localhost:3000/ws`
- [ ] forced service close triggers daemon reconnect
- [ ] reconnect still works with active proxy/file work
- [ ] behavior matches the HTTPS/Caddy path

## Regression Validation

- [x] daemon startup without Web views still works
- [x] terminal-only reconnect still works
- [x] local HTTP proxy requests still stream responses
- [x] local WebSocket proxy sessions still forward text/binary messages
- [ ] file viewer/file stream behavior still works
- [x] no service, web, mobile, Caddy, OAuth, or DB changes were introduced

## Notes

- If a validation command fails, capture the exact command and error output and
  stop for human guidance.
- Manual sleep/resume validation should be run with an active Web view/HMR
  session because that is the highest-signal reproduction path.
- 2026-05-19: User validated the local HTTPS path with macOS sleep/resume and
  Caddy process termination. Both recovered as expected. Direct `ws://` forced
  close and file viewer-specific stream validation remain unchecked.

## Phase 4: Connection Deadlines

October 2026 implementation; earlier manual results above validate Phases 1–3,
not the new startup deadlines.

- [x] Silent HTTP upgrade and TLS handshake expire and dispose of sockets
- [x] Silent authentication and challenge-without-ack expire
- [x] Pings and valid unexpected frames cannot refresh authentication deadline
- [x] Automatic retry uses the same stored identity and emits reconciliation
- [x] Delayed valid authentication succeeds; healthy idle session exceeds startup budgets
- [x] gRPC control/data setup expires without waiting on retained writer senders
- [x] gRPC authentication timeout remains distinct from explicit `AUTH_FAILED`
- [x] gRPC setup timeout falls back to authenticated WebSocket
- [x] Caller cancellation disposes pending WebSocket auth/gRPC setup sockets
- [x] Setup writer cancellation closes its receiver despite a retained sender
- [x] Enrollment ack persists credentials; explicit auth rejection remains classified
- [x] Existing terminal offset-exact reattachment and disconnect regressions pass
- [x] Changed Rust file formatting and `git diff --check` pass
- [ ] Physical macOS sleep/resume during startup and network restoration
- [ ] Install released daemon and confirm production recovery after release approval

Commands:

```text
cargo test --manifest-path bud/Cargo.toml --lib app::tests
cargo test --manifest-path bud/Cargo.toml --quiet
cargo clippy --manifest-path bud/Cargo.toml --all-targets
rustfmt --edition 2021 --check bud/src/app.rs
git diff --check
```

Tests use temporary state and loopback peers, including a stalled real TLS client
and a real gRPC client awaiting setup. gRPC auth exchange cases use typed envelope
streams; these are not a deployed end-to-end gRPC data-attachment/heartbeat test.
Existing transport tests verify terminal fallback and unsupported generic-stream
failure. No installed service was restarted and no production identity was used.

Final automated results: 271 tests passed (235 library, 36 executable integration),
11 existing browser fixtures ignored, no failures. All 11 app tests passed,
including nine new connection-recovery regressions.

Clippy succeeds with an existing `await_holding_lock` warning in browser-manager
test code. Whole-package format check reports existing browser-manager formatting;
the changed `app.rs` is formatted. Established half-open liveness remains a
separate follow-up, as specified in Phase 4.
