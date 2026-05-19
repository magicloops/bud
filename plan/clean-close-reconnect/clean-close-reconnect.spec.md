# Clean Close Reconnect Plan Spec

## Purpose

This folder contains the implementation plan for fixing daemon reconnect stalls
after the service, Caddy, or the operating system closes the Bud WebSocket. The
triggering report came from macOS sleep/resume while using the local
mkcert+Caddy HTTPS profile, but the root risk is daemon-side transport cleanup:
old proxy/file work can keep cloned transport senders alive and prevent the
session loop from returning to the reconnect loop.

The plan keeps this as a daemon transport lifecycle hardening task. It does not
change Caddy routing, local HTTPS setup, service WebSocket auth, proxy protocol
frames, browser APIs, or database schema.

## Files

- `implementation-spec.md`: Overall approach, constraints, affected surfaces,
  acceptance criteria, and validation plan.
- `phase-1-nonblocking-websocket-session-teardown.md`: Ensure a WebSocket
  close/error cannot block reconnect on writer-task channel drain.
- `phase-2-proxy-file-disconnect-cancellation.md`: Explicitly cancel daemon
  proxy/file tasks when the active transport disconnects.
- `phase-3-regression-tests-and-validation.md`: Add focused daemon regression
  coverage and manual sleep/resume validation.
- `progress-checklist.md`: Running implementation status board.
- `validation-checklist.md`: Runtime and regression validation checklist.

## Dependencies

- [../../debug/bud-daemon-sleep-resume-reconnect-stall.md](../../debug/bud-daemon-sleep-resume-reconnect-stall.md)
  - investigation note for the reported sleep/resume reconnect stall.
- [../../debug/bud-reconnect-after-service-restart.md](../../debug/bud-reconnect-after-service-restart.md)
  - older reconnect investigation that identified delayed close detection.
- [../../debug/bud-daemon-local-https-mkcert-unknown-issuer.md](../../debug/bud-daemon-local-https-mkcert-unknown-issuer.md)
  - confirms the previous mkcert trust issue has a separate root cause.
- [../../bud/bud.spec.md](../../bud/bud.spec.md) - daemon package overview.
- [../../bud/src/src.spec.md](../../bud/src/src.spec.md) - daemon source
  ownership and transport responsibilities.
- [../../bud/src/proxy/proxy.spec.md](../../bud/src/proxy/proxy.spec.md)
  - daemon-side localhost proxy ownership.
- [../../bud/src/files/files.spec.md](../../bud/src/files/files.spec.md)
  - daemon-side file stream ownership.

## Primary Areas Expected To Change

- `bud/src/app.rs`: WebSocket session shutdown should return promptly after
  read-side close/error, and should not wait indefinitely for old writer-task
  channel drain.
- `bud/src/proxy/mod.rs`: active HTTP proxy streams and local WebSocket proxy
  sessions need transport-disconnect cancellation.
- `bud/src/files/mod.rs`: active file streams need transport-disconnect
  cancellation.
- `bud/src/src.spec.md`, `bud/src/proxy/proxy.spec.md`,
  `bud/src/files/files.spec.md`, and `bud/bud.spec.md`: update ownership notes
  once the implementation lands.

## Fixed Direction

- Treat a closed daemon control transport as terminal for all work tied to that
  transport.
- Prefer fast reconnect over graceful draining of a dead WebSocket.
- Keep terminal cleanup behavior intact.
- Make proxy/file cleanup explicit instead of relying on future service reset
  frames that cannot arrive over a closed transport.
- Preserve existing protocol shapes and service contracts.
- Add regression coverage that would fail if a cloned proxy/file sender can
  block session return after a close.

## Open Decision Gates

- Whether to add a transport generation id inside the daemon managers now, or
  keep a simpler "one active transport per daemon process" cancellation model
  until concurrent carriers require stricter scoping.
- Whether to add daemon debug logging for active proxy/file counts in normal
  operation or only around disconnect cleanup.
- Whether to harden gRPC control/data session cleanup in the same PR. The
  immediate repro is WebSocket, but proxy/file cancellation should be reusable
  across carriers.

