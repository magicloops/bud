# Phase 2: Proxy/File Disconnect Cancellation

## Context

Phase 1 prevents old proxy/file tasks from blocking reconnect, but those tasks
can still remain alive after the control transport is gone. This phase cancels
transport-bound proxy/file work explicitly.

`ProxyManager` currently tracks active HTTP proxy streams and WebSocket proxy
sessions by id. `FileManager` tracks active file streams by id. Both managers
expect the service to send reset/close events over the active transport. After
the control transport closes, those reset events cannot arrive.

## Objective

When the active daemon transport disconnects, all proxy/file tasks tied to that
transport should be notified, removed from manager maps, and allowed to exit.

## Scope

- Add disconnect cleanup to `ProxyManager`.
- Add disconnect cleanup to `FileManager`.
- Call manager cleanup from WebSocket shutdown.
- Reuse the same cleanup in gRPC shutdown where applicable.
- Handle event-channel closure in proxy WebSocket task loops.
- Log counts of canceled streams/sessions.

## Non-Goals

- No stream resume protocol.
- No durable stream reconciliation redesign.
- No service data-plane changes.
- No local app/HMR behavior changes except clean cancellation during daemon
  disconnect.

## Design / Approach

### ProxyManager

Add a method such as:

```rust
pub async fn abort_all_for_transport_disconnect(&self, reason: &str) -> ProxyAbortSummary
```

Expected behavior:

- collect active HTTP proxy stream senders
- collect active WebSocket proxy session senders
- clear both maps
- send `ProxyStreamEvent::Reset` to each HTTP stream
- send `ProxyWebSocketEvent::Error` or `Close` to each WebSocket session
- return counts for logging

Also update the WebSocket proxy select loop. Today it only matches:

```rust
Some(event) = event_rx.recv() => { ... }
```

If the sender side is dropped without sending an event, that branch stops
participating and the task may wait forever on local `ws_read.next()`. Change it
to handle `None` as a local task shutdown.

### FileManager

Add a method such as:

```rust
pub async fn abort_all_for_transport_disconnect(&self, reason: &str) -> FileAbortSummary
```

Expected behavior:

- collect active file stream senders
- clear the stream map
- send `FileStreamEvent::Reset` to each active stream
- return counts for logging

### App Integration

Call proxy/file abort methods during session shutdown before or alongside
run/terminal sender cleanup.

The expected order:

1. prevent new writes from the active run/terminal path
2. notify proxy/file tasks that the transport is gone
3. drop the session sender
4. stop writer/data tasks
5. return to reconnect

Exact ordering can be adjusted for borrow/lifetime simplicity as long as old
proxy/file tasks cannot keep the session alive.

## Edge Cases

- Some stream sender channels may already be closed. Cleanup should ignore send
  failures and continue.
- Some tasks may be between map registration and local connection setup. The
  abort method should still send cancellation through the registered channel.
- A task can unregister itself after the abort method already cleared the map.
  Unregister should remain idempotent.
- A new daemon session should not inherit stale proxy/file map entries.

## Test Plan

Automated:

1. Register an HTTP proxy stream, call disconnect cleanup, assert the stream
   receives reset and the map is empty.
2. Register a proxy WebSocket session, call disconnect cleanup, assert the task
   exits or receives the shutdown event.
3. Close a WebSocket event channel without sending an event and assert the task
   exits.
4. Register a file stream, call disconnect cleanup, assert the stream receives
   reset and the map is empty.

Manual:

1. Open a Web view with HMR active.
2. Force service/Caddy close.
3. Confirm daemon logs canceled proxy WebSocket session count.
4. Confirm reconnect proceeds.

## Acceptance Criteria

- Proxy HTTP streams waiting for credit exit after transport disconnect.
- Proxy WebSocket sessions exit after transport disconnect.
- File streams waiting for credit exit after transport disconnect.
- Manager maps are empty after disconnect cleanup.
- Reconnect works even with active Web view/HMR proxy sessions.

