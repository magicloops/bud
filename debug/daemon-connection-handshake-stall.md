# Debug: Daemon stalled before connection authentication completed

## Environment

- Installed macOS ARM64 daemon v0.1.25, release commit `058b677199f322efd5eac53553cf960f84ff9de2`.
- Production: `~/.bud/bin/bud`, state `~/.bud`, launchd `dev.bud.daemon`, server `wss://app.bud.dev/ws`.
- Existing identity: `mbp-m4`, Bud `b_01M4FS26AEEKVVQ2PB01TFM5GV`.
- Independent development daemon: `~/.bud-dev`, `wss://localhost:3443/ws`; left running throughout investigation and restart.
- Investigation October 10 PDT / October 11 UTC, 2026. No DB or LLM changes.

## Repro Steps

1. User reported the installed local Bud unavailable on production.
2. Inspect launchd, process, daemon logs, open sockets and a process sample.
3. Probe current HTTPS and anonymous WebSocket upgrade reachability.
4. With user authorization, restart only the installed production daemon.

## Observed

Old PID `85549` remained running. Its last connection sequence was:

```text
2026-10-10T18:39:50.472189Z shutting down WebSocket session transport reason=websocket_read_error
... cleanup complete
Session failed; retrying error=Connection reset by peer (os error 54)
2026-10-10T18:39:55.474285Z Connecting to backend server=wss://app.bud.dev/ws
```

At `2026-10-11T05:57:56Z`, there was still no handshake, failure or retry log:
over eleven hours without progress. The daemon had an established TCP connection
to port 443; sampled runtime threads were idle/parked. HTTPS returned 200 and a
fresh anonymous `/ws` upgrade returned 101. These probes establish current
reachability, not whether the old connection completed TLS, upgrade or Bud auth.

Restart command, with inherited `BUD_*` variables removed:

```text
/Users/adam/.bud/bin/bud --base-dir /Users/adam/.bud restart
```

New PID `84082` connected with the same identity:

```text
2026-10-11T06:00:27.880428Z Connecting to backend server=wss://app.bud.dev/ws
2026-10-11T06:00:29.149878Z Handshake established bud_id=b_01M4FS26AEEKVVQ2PB01TFM5GV session_id=s_01M4MRRS76JA30N2KC0J2HCRBE heartbeat_sec=30
2026-10-11T06:00:29.219199Z reconnect reconciliation decision received operation_count=0 stream_count=0
```

Terminal replay followed; user confirmed availability restored. Development
daemon PID `67589` remained running. Restart did not change identities or profiles.

## Expected

A silent connection attempt should expire and return to the normal reconnect
loop without needing a service restart or a new device claim.

## Hypotheses

- Confirmed code gap: `connect_async` and the entire Bud authentication exchange
  in `bud/src/app.rs` have no explicit deadlines. Either can await indefinitely.
- Exact blocked stage is unproven: the existing log surrounds both transport
  setup and authentication. Established TCP alone does not distinguish them.
- Optional gRPC control/data setup has equivalent unbounded waits. Its setup
  error paths also await a writer while retaining a channel sender; adding only
  a timeout around the network call would leave another cleanup stall.
- This is separate from the previously fixed
  [session teardown stall](bud-daemon-sleep-resume-reconnect-stall.md): cleanup
  completed and the next connection attempt started in this incident.
- Established half-open connections are an adjacent gap, not established as
  this incident's cause. Heartbeat enqueue success does not prove delivery.

## Proposed Fix

Implement [Clean Close Reconnect Phase 4](../plan/clean-close-reconnect/phase-4-connection-and-authentication-deadlines.md):
bounded setup/authentication, cancellation-safe attempt cleanup, stage timing
logs and deterministic silent-peer recovery tests. Preserve existing identity,
auth rejection behavior, reconciliation and persistent terminal semantics.

Affected implementation specs: `bud/src/src.spec.md`, `bud/bud.spec.md`, and
`bud/tests/tests.spec.md` if adding an integration test file. No service, web,
mobile, DB or protocol-shape change is planned. This note records analysis;
the timeout fix is now implemented in the working tree, with validation below.

## Implementation and verification

- `app.rs` applies 30-second transport, 20-second network authentication and
  10-second optional data setup budgets. Existing retry/fallback and explicit
  auth rejection remain distinct; startup timeouts never clear identity.
- Pending gRPC writers abort on timeout/error/cancellation. Enrollment writes
  happen after the network exchange so its deadline cannot interrupt persistence.
- Temporary-state loopback tests cover stalled HTTP upgrade/TLS/auth, ping noise,
  same-identity automatic retry/reconciliation, healthy idle lifetime, gRPC
  setup/auth/fallback, socket disposal and caller cancellation. No installed
  service or real browser profile is used by these fixtures.
- Initial `cargo test --manifest-path bud/Cargo.toml --lib app::tests -- --nocapture`
  failed with `E0560` (`TerminalConfig` has no field `connection_budgets`) and
  `E0063` (missing `BudApp.connection_budgets`). Corrected the initializer placement;
  focused tests then passed.
- `cargo fmt --manifest-path bud/Cargo.toml --check` initially reported app
  formatting plus pre-existing formatting in `browser/manager.rs`. Applied
  `rustfmt --edition 2021 bud/src/app.rs` only; unrelated browser code preserved.
- `cargo clippy --manifest-path bud/Cargo.toml --all-targets` succeeds with a
  pre-existing `await_holding_lock` warning in browser-manager test code.
- Final test counts and remaining physical acceptance are tracked in the
  [validation checklist](../plan/clean-close-reconnect/validation-checklist.md#phase-4-connection-deadlines).
