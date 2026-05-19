# Plan: Clean Close Reconnect

## Context

After the local mkcert+Caddy HTTPS profile was added, the Bud daemon can fail to
reconnect after a dev machine sleeps and resumes. The observed daemon log is:

```text
INFO Server closed connection frame=None
```

The debug pass found that the daemon does detect the WebSocket close, but
`run_session(...)` can stall before returning to the outer reconnect loop. The
most likely mechanism is that active proxy/file tasks hold cloned
`TransportSender` values for the old WebSocket. The session close branch drops
the local sender and clears terminal/run senders, then awaits the writer task.
The writer task exits only after all senders are dropped. Long-lived
`proxy_ws_open` tasks, especially Vite/HMR WebSocket sessions created by Web
views, can keep those senders alive.

Related docs:

- [../../debug/bud-daemon-sleep-resume-reconnect-stall.md](../../debug/bud-daemon-sleep-resume-reconnect-stall.md)
- [../../debug/bud-reconnect-after-service-restart.md](../../debug/bud-reconnect-after-service-restart.md)
- [clean-close-reconnect.spec.md](clean-close-reconnect.spec.md)

## Objective

Make the daemon reconnect promptly whenever the active WebSocket control
transport closes or errors, even if old proxy/file tasks are still active. Old
transport-bound work should be canceled or made unable to block reconnect.

Acceptance at the plan level:

- `Server closed connection frame=None` is followed by the normal reconnect
  loop.
- Active Web view/HMR proxy sessions cannot keep the old writer task alive.
- File/proxy streams waiting for credit or service events are canceled on
  transport disconnect.
- Terminal session cleanup remains intact.
- No Bud-visible or browser-visible protocol shape changes are required.

## Non-Goals

- No Caddy routing changes.
- No mkcert/local HTTPS trust changes.
- No service WebSocket auth changes.
- No database migrations.
- No proxy protocol redesign.
- No mobile or web UI changes.
- No attempt to preserve in-flight proxy/file streams across daemon reconnect in
  this phase. Reconnect reconciliation can continue to classify interrupted
  streams as reset/unknown according to existing service behavior.

## Design / Approach

### Phase 1: Nonblocking WebSocket Session Teardown

Make WebSocket session shutdown mirror the gRPC cleanup posture more closely:
once the control transport is closed or errored, reconnect should not depend on
old channel drain.

Implementation direction:

- factor WebSocket session cleanup into a helper in `bud/src/app.rs`
- clear run and terminal senders as today
- drop the local session sender
- abort the writer task, or time-bound awaiting it, after read-side close/error
- use the helper for:
  - heartbeat send failure
  - Pong send failure
  - read-side `Message::Close`
  - read-side WebSocket error
  - read stream ending with `None`
- add targeted debug/info logs before and after cleanup so the next repro can
  distinguish "close detected" from "cleanup completed"

This phase alone should make reconnect return promptly even if an old task still
holds a `TransportSender` clone, because the writer receiver is dropped when the
writer task is aborted.

### Phase 2: Proxy/File Disconnect Cancellation

Make daemon-side proxy and file managers aware that the active transport has
ended.

Implementation direction:

- add a disconnect cleanup method on `ProxyManager`
  - send a reset/error event to every active HTTP proxy stream
  - send a close/error event to every active WebSocket proxy session
  - clear manager maps after notifying tasks
  - handle closed event channels without panicking
- update the proxy WebSocket select loop so event-channel closure also exits
  the task, rather than only matching `Some(event)`
- add a disconnect cleanup method on `FileManager`
  - send reset events to active file streams
  - clear manager maps after notifying tasks
- call these cleanup methods from WebSocket and gRPC session shutdown paths
- log the number of canceled proxy streams, proxy WebSocket sessions, and file
  streams

This phase removes stale local tasks instead of merely making them unable to
block reconnect.

### Phase 3: Regression Tests And Validation

Add focused coverage for the failure mode and validate the real sleep/resume
path.

Implementation direction:

- add unit coverage for `ProxyManager` disconnect cleanup:
  - HTTP proxy stream waiting for credit exits after disconnect cleanup
  - WebSocket proxy session exits after disconnect cleanup or event-channel
    closure
- add unit coverage for `FileManager` disconnect cleanup:
  - file stream waiting for credit exits after disconnect cleanup
- add an app/session-level regression if practical:
  - simulate a connected WebSocket session
  - keep a cloned sender alive through a proxy-like task
  - deliver `Message::Close(None)`
  - assert the session returns instead of waiting for sender drop
- run daemon tests plus manual sleep/resume validation with an active Web view
  and Vite/HMR page

## Spec Files To Update When Implementing

- [ ] `bud/src/src.spec.md`
- [ ] `bud/src/proxy/proxy.spec.md`
- [ ] `bud/src/files/files.spec.md`
- [ ] `bud/bud.spec.md`
- [ ] `plan/clean-close-reconnect/clean-close-reconnect.spec.md` if scope or
  sequencing changes

## Impacted Contracts

- [ ] WSS protocol: no shape change
- [ ] SSE events: no
- [ ] DB schema: no
- [ ] Agent tools: no
- [ ] Web UI: no
- [x] Daemon runtime lifecycle: yes
- [x] Daemon local proxy/file task lifecycle: yes

## Test Plan

Automated:

```bash
cargo test --manifest-path /Users/adam/bud/bud/Cargo.toml
```

Focused tests to add or update:

1. WebSocket session close returns even when a cloned sender remains alive.
2. Proxy HTTP stream waiting for credit exits on transport disconnect cleanup.
3. Proxy WebSocket task exits on disconnect cleanup.
4. File stream waiting for credit exits on transport disconnect cleanup.
5. Existing proxy WebSocket echo and file read tests still pass.

Manual validation:

1. Start the HTTPS local stack with `pnpm dev:https`.
2. Start Bud with `BUD_SERVER_URL=wss://localhost:3443/ws`.
3. Open a Web view pointed at a Vite app so HMR WebSocket proxying is active.
4. Sleep the machine.
5. Resume the machine.
6. Confirm the daemon logs `Server closed connection frame=None`, then
   `Session ended; reconnecting`, then a new `Connecting to backend`.
7. Confirm the service marks the Bud online again.
8. Confirm terminal and Web view recovery paths still work.
9. Repeat with direct `ws://localhost:3000/ws` to prove the fix is not
   Caddy-specific.

## Rollout

1. Implement Phase 1 first to remove the reconnect blocker.
2. Implement Phase 2 to clean up old transport-bound work explicitly.
3. Add Phase 3 tests and run daemon validation.
4. Update affected daemon specs.
5. Capture manual sleep/resume results in `validation-checklist.md` and the PR
   summary.

## Acceptance Criteria

- The daemon reconnect loop resumes after a server close even with an active
  Web view/HMR proxy session.
- WebSocket close/error cleanup no longer waits indefinitely for all old sender
  clones to drop.
- Active proxy/file tasks are canceled when the active daemon transport ends.
- No old proxy/file task can write successfully to a superseded or closed
  transport.
- Existing terminal reconnect and output cleanup behavior remains intact.
- Existing daemon proxy/file tests continue to pass.
- No service, web, mobile, Caddy, DNS, OAuth, or database contract changes are
  introduced.

