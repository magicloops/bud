# Phase 9b: Daemon Local WebSocket Echo

## Context

Vite HMR now works through the proxy, but the daemon local WebSocket bridge
needs direct echo coverage so the protocol contract is not coupled to one
framework smoke test.

Related docs:

- `phase-5a-protocol-and-daemon-websocket-bridge.md`
- `phase-5d-websocket-regression-and-failure-states.md`
- `validation-checklist.md`

## Objective

Prove that the Bud daemon can connect to allowed loopback WebSocket targets,
preserve message semantics, and reject unsafe targets before any local
connection is opened.

## Scope

- Daemon local WebSocket client.
- Loopback target validation for WebSocket opens.
- Text/binary/close/error mapping to `proxy_ws_*` frames.
- Local connect failure behavior.

## Non-Goals

- No service gateway tests; Phase 9c owns browser-to-local gateway echo.
- No production edge or TLS behavior; Phase 9f and Phase 8 own those.
- No new protocol frame shapes unless tests uncover a required fix.

## Design / Approach

Add daemon tests with an in-process local echo server and a fake service
carrier:

- connect to `localhost`
- connect to `127.0.0.1`
- connect to `::1` where the host supports IPv6 loopback
- send/receive text frames
- send/receive binary frames
- propagate local close code/reason to service frames
- propagate browser/service close code/reason to the local socket
- reject unsupported hostnames and non-loopback resolved addresses
- return typed local-connect failures for closed ports

Keep the echo harness small and deterministic. If IPv6 loopback support is not
reliable in CI, make the `::1` case conditional and document the skip reason.

## Spec Files To Update

- [x] `bud/src/src.spec.md`
- [ ] `docs/proto.md` if frame semantics change
- [x] `plan/web-proxy/progress-checklist.md`
- [x] `plan/web-proxy/validation-checklist.md`

## Impacted Contracts

- [ ] WSS protocol: only if close/error semantics change
- [ ] SSE events: no
- [ ] DB schema: no
- [ ] Agent tools: no
- [ ] Web UI: no

## Test Plan

Run the focused daemon tests that cover the local WebSocket bridge:

```bash
cargo test -p bud proxy::tests::websocket_proxy
```

## Implemented Coverage

- `bud/src/proxy/mod.rs` now has an in-process `127.0.0.1` WebSocket echo
  test that verifies daemon `proxy_ws_open`, text echo, binary echo, and local
  close propagation through the transport sender.
- The same module now covers daemon-side `localhost` loopback resolution,
  unsupported WebSocket targets rejected with `POLICY_DENIED`, and closed-port
  local connect failures rejected with retryable `LOCAL_CONNECT_FAILED`.
- Direct `localhost` and conditional `::1` echo-server cases remain follow-up
  coverage because they are more sensitive to CI host resolver/listener
  behavior.

## Acceptance Criteria

- Text, binary, close, and local error behavior are covered.
- `localhost` is revalidated as loopback before connecting.
- Unsupported and non-loopback targets fail before local connection.
- Local connect failures produce typed `proxy_ws_open_result` rejection or
  error behavior.
