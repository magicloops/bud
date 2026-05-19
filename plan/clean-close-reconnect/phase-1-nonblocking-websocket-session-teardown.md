# Phase 1: Nonblocking WebSocket Session Teardown

## Context

`BudApp::run_session(...)` logs `Server closed connection` when the service or
Caddy closes the WebSocket, but it currently awaits the writer task before
returning to the reconnect loop. The writer task owns the WebSocket write half
and waits on an unbounded channel. If any cloned `TransportSender` survives, the
channel stays open and the writer task can wait forever.

This phase makes reconnect independent of old sender-clone lifetime.

Related docs:

- [implementation-spec.md](implementation-spec.md)
- [../../debug/bud-daemon-sleep-resume-reconnect-stall.md](../../debug/bud-daemon-sleep-resume-reconnect-stall.md)

## Objective

Ensure that WebSocket read-side close/error paths complete session shutdown and
return to the outer reconnect loop promptly.

## Scope

- Add a WebSocket shutdown helper in `bud/src/app.rs`.
- Use the helper consistently across all WebSocket session exit paths.
- Abort or time-bound the writer task once the control transport is known dead.
- Add concise logs around shutdown start/completion.
- Preserve existing run/terminal sender cleanup.

## Non-Goals

- No proxy/file manager cleanup yet. Phase 2 owns explicit task cancellation.
- No protocol changes.
- No changes to service gateway behavior.
- No Caddy changes.

## Design / Approach

### Cleanup Helper

Create a helper with the same intent as `shutdown_grpc_session(...)`, scoped to
WebSocket sessions. It should:

1. clear the run executor sender
2. clear the terminal manager sender
3. drop the session-local `TransportSender`
4. stop the writer task without waiting for every old sender clone to drop
5. log cleanup completion

The key behavior is step 4. The writer task should not be allowed to keep the
session alive after read-side close/error.

### Exit Paths To Cover

Use the helper for:

- heartbeat send failure
- Pong send failure
- `Message::Close(frame)`
- read-side WebSocket errors
- read stream ending with `None`

### Writer Task Failure

If practical in the same phase, surface writer-task failure back into
`run_session(...)` with a small completion signal and select branch. This makes
write-half failures drive reconnect without waiting for the next heartbeat.

This is useful hardening, but the must-have fix is nonblocking cleanup after the
read loop already sees close/error.

## Edge Cases

- Old proxy/file tasks may still hold sender clones after Phase 1. They should
  receive `transport disconnected` on the next send because the writer receiver
  has been dropped.
- A proxy WebSocket task that is idle may remain alive until Phase 2 cancels it,
  but it must not block reconnect.
- Terminal output watchers should still be aborted by
  `TerminalManager::clear_sender()`.

## Test Plan

Automated, if practical:

1. Simulate a WebSocket session with a cloned sender still alive.
2. Deliver a close frame.
3. Assert session shutdown returns without requiring the cloned sender to drop.

Manual:

1. Start the daemon with `BUD_DEBUG=true`.
2. Reproduce a close event.
3. Confirm logs show:
   - `Server closed connection`
   - WebSocket session cleanup start
   - WebSocket session cleanup complete
   - `Session ended; reconnecting`

## Acceptance Criteria

- A WebSocket close frame cannot block reconnect on writer-task channel drain.
- All existing WebSocket session exit paths share the same cleanup behavior.
- Terminal cleanup still runs on disconnect.
- No service or protocol changes are required.

