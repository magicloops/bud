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
