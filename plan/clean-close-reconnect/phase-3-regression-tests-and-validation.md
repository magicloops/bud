# Phase 3: Regression Tests And Validation

## Context

The failure is lifecycle-sensitive: a WebSocket close occurs while long-lived
proxy/file work may still hold sender clones. We need tests that prove the
daemon does not regress into waiting for old transport work before reconnecting.

## Objective

Add automated coverage for the reconnect-blocking mechanics and validate the
real sleep/resume behavior on the local HTTPS profile.

## Scope

- Daemon unit tests for new cleanup behavior.
- Existing daemon proxy/file test preservation.
- Manual sleep/resume validation steps.
- Documentation/spec updates after implementation.

## Non-Goals

- No browser automation requirement.
- No CI-only sleep simulation.
- No production Cloudflare/Render validation requirement for this local
  sleep/resume bug.

## Automated Test Targets

### App Session Teardown

Preferred coverage:

1. Start or simulate a WebSocket session.
2. Keep an extra cloned `TransportSender` alive.
3. Deliver `Message::Close(None)` or equivalent close condition.
4. Assert session shutdown returns without waiting for the clone to drop.

If direct `BudApp::run_session(...)` testing is too invasive, extract the
writer-task shutdown behavior into a small testable helper and cover that
helper directly.

### Proxy Cleanup

Add focused tests in `bud/src/proxy/mod.rs`:

- active HTTP proxy stream receives reset on transport disconnect cleanup
- active WebSocket proxy session receives close/error on transport disconnect
  cleanup
- proxy WebSocket loop exits when its event channel closes
- cleanup is idempotent when streams unregister concurrently

### File Cleanup

Add focused tests in `bud/src/files/mod.rs`:

- active file stream receives reset on transport disconnect cleanup
- cleanup clears the stream map
- cleanup tolerates already-closed stream event channels

## Recommended Commands

```bash
cargo test --manifest-path /Users/adam/bud/bud/Cargo.toml
```

If the command fails, capture the exact output and stop for human guidance per
repo operating rules.

## Manual Validation

### Local HTTPS Sleep/Resume

1. Run `pnpm dev:https`.
2. Start the daemon with:

```bash
BUD_SERVER_URL=wss://localhost:3443/ws BUD_TERMINAL_ENABLED=true BUD_DEBUG=true cargo run --manifest-path /Users/adam/bud/bud/Cargo.toml
```

3. Open a thread Web view for a local Vite app.
4. Confirm HMR/WebSocket proxy traffic is active if possible.
5. Let the Mac sleep.
6. Resume the Mac.
7. Confirm the daemon logs:
   - `Server closed connection frame=None`
   - cleanup completion
   - `Session ended; reconnecting`
   - a fresh `Connecting to backend`
   - a fresh `Handshake established`
8. Confirm terminal use recovers.
9. Confirm Web view reload/reconnect recovery still works.

### Direct WebSocket Control

Repeat the same forced-close validation with direct service routing:

```bash
BUD_SERVER_URL=ws://localhost:3000/ws BUD_TERMINAL_ENABLED=true BUD_DEBUG=true cargo run --manifest-path /Users/adam/bud/bud/Cargo.toml
```

This confirms the fix is daemon lifecycle hardening, not Caddy-specific.

## Docs / Specs To Update

- `bud/src/src.spec.md`
- `bud/src/proxy/proxy.spec.md`
- `bud/src/files/files.spec.md`
- `bud/bud.spec.md`
- `plan/clean-close-reconnect/progress-checklist.md`
- `plan/clean-close-reconnect/validation-checklist.md`

## Acceptance Criteria

- Automated daemon tests cover close cleanup with old sender clones.
- Automated proxy/file tests cover disconnect cancellation.
- Manual sleep/resume validation passes with active Web view/HMR proxy traffic.
- Direct `ws://localhost:3000/ws` reconnect validation passes.
- Specs describe the new transport-disconnect cleanup ownership.

