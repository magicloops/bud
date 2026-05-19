# Debug: Bud Daemon Sleep/Resume Reconnect Stall

## Environment

- Date: 2026-05-19
- Dev machine sleep/resume with the local HTTPS profile in use
- Daemon endpoint: likely `wss://localhost:3443/ws` through Caddy
- Caddy route: `https://localhost:3443/ws` reverse-proxies to Fastify at
  `127.0.0.1:3000`
- Investigation method: static implementation review only; no code changes made

## Repro Steps

1. Start the local HTTPS profile.
2. Start the Bud daemon against the HTTPS WebSocket endpoint.
3. Use the web app normally, especially a proxied Web view/HMR page.
4. Let the dev machine sleep.
5. Resume the machine.
6. Observe the daemon log:

```text
2026-05-19T06:35:42.261138Z  INFO Server closed connection frame=None
```

7. Observe that the Bud does not automatically reconnect to the backend.

## Observed

- The daemon does detect a WebSocket close frame from the server/Caddy path.
- The reported close frame has no close payload: `frame=None`.
- The expected follow-up daemon log would be `Session ended; reconnecting`,
  followed by another `Connecting to backend`.
- The reported symptom suggests that follow-up reconnect loop is not reached.

## Expected

- A server-side close after sleep/resume should end the current daemon session.
- `BudApp::run(...)` should sleep for `BUD_RECONNECT_BASE_SEC` seconds, default
  `5`, then call `connect_once()` again.
- Any proxy/file/terminal work attached to the old transport should not prevent
  reconnect.

## Reviewed Files

- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- `bud/src/app.rs`
- `bud/src/config.rs`
- `bud/src/transport.rs`
- `bud/src/proxy/proxy.spec.md`
- `bud/src/proxy/mod.rs`
- `bud/src/files/mod.rs`
- `bud/src/terminal/mod.rs`
- `bud/src/terminal/tmux.rs`
- `bud/src/run.rs`
- `bud/.env.https.example`
- `bud/Cargo.toml`
- `dev/dev.spec.md`
- `dev/caddy/caddy.spec.md`
- `dev/caddy/Caddyfile.https-local`
- `dev/local-https.mjs`
- `service/src/ws/ws.spec.md`
- `service/src/ws/gateway.ts`
- `service/src/ws/bud-connection.ts`
- `service/src/ws/session-trackers.ts`
- `service/src/config.ts`
- Prior related notes:
  - `debug/bud-reconnect-after-service-restart.md`
  - `debug/bud-daemon-local-https-mkcert-unknown-issuer.md`
  - `debug/web-proxy-reconnect-stale-offline-transport.md`
  - `debug/staging-false-bud-offline-terminal-503s.md`

## Current Flow

### Daemon reconnect loop

`BudApp::run(...)` is an infinite reconnect loop:

1. Call `connect_once()`.
2. Log `Session ended; reconnecting` on `Ok(())`, or
   `Session failed; retrying` on error.
3. Sleep `reconnect_base_sec`.
4. Try again.

Relevant code:

- `bud/src/app.rs:141`
- `bud/src/app.rs:153`
- `bud/src/app.rs:158`
- `bud/src/config.rs:30`

### WebSocket session close handling

`run_session(...)` splits the WebSocket into read and write halves. The write
half is owned by a spawned task that drains an unbounded channel. The read loop
receives server frames.

On `Message::Close(frame)`, the daemon:

1. logs `Server closed connection`
2. clears the run sender
3. clears the terminal sender and aborts terminal output watchers
4. drops the local `sender`
5. awaits `writer_handle`
6. returns `Ok(())` to the outer reconnect loop

Relevant code:

- `bud/src/app.rs:807`
- `bud/src/app.rs:812`
- `bud/src/app.rs:866`
- `bud/src/app.rs:868`
- `bud/src/app.rs:871`
- `bud/src/app.rs:872`

### Transport sender ownership

`TransportSender::websocket(...)` wraps the WebSocket write-channel sender in an
`Arc`, and cloning `TransportSender` keeps that underlying channel alive.

Relevant code:

- `bud/src/transport.rs:18`
- `bud/src/transport.rs:25`
- `bud/src/transport.rs:39`
- `bud/src/transport.rs:116`

### Proxy/file tasks clone the transport sender

The dispatcher passes `sender.clone()` into long-lived proxy and file work:

- `proxy_open`
- `proxy_ws_open`
- `file_open`
- `file_resolve`

Relevant code:

- `bud/src/app.rs:938`
- `bud/src/app.rs:944`
- `bud/src/app.rs:960`
- `bud/src/app.rs:979`

The proxy manager spawns tasks that own those senders:

- HTTP proxy tasks hold `sender` while streaming response data or waiting for
  credit.
- WebSocket proxy tasks hold `sender` for the lifetime of the local WebSocket.
- The manager stores event channels for active streams/sessions, but it does
  not store task handles or expose a "disconnect all old transport work" hook.

Relevant code:

- `bud/src/proxy/mod.rs:84`
- `bud/src/proxy/mod.rs:94`
- `bud/src/proxy/mod.rs:102`
- `bud/src/proxy/mod.rs:104`
- `bud/src/proxy/mod.rs:194`
- `bud/src/proxy/mod.rs:221`
- `bud/src/proxy/mod.rs:422`
- `bud/src/proxy/mod.rs:462`

The file manager has a similar task shape for file read/resolve operations:

- `bud/src/files/mod.rs:89`
- `bud/src/files/mod.rs:96`
- `bud/src/files/mod.rs:103`
- `bud/src/files/mod.rs:105`

### Local HTTPS/Caddy shape

The local HTTPS profile starts service, web, and Caddy together. Caddy forwards
`/ws` to the Fastify service:

- `dev/local-https.mjs:509`
- `dev/local-https.mjs:537`
- `dev/local-https.mjs:547`
- `dev/caddy/Caddyfile.https-local:8`

The daemon HTTPS template points the daemon at:

```text
BUD_SERVER_URL=wss://localhost:3443/ws
```

Relevant code:

- `bud/.env.https.example`

## Findings

### 1. The daemon should reconnect after a clean close, but cleanup can block first

The close branch is structurally capable of reconnecting: it returns `Ok(())`,
and the outer loop reconnects. However, it only returns after awaiting the
writer task.

That writer task exits only when the WebSocket write-channel receiver sees all
senders dropped. The close branch drops the local sender and clears run/terminal
senders, but it does not cancel proxy/file tasks that were given cloned
`TransportSender` values.

If any old proxy/file task is still alive, the writer channel stays open, the
writer task waits on `rx.recv().await`, `run_session(...)` does not return, and
the outer reconnect loop is never reached.

This fits the reported log shape: the daemon gets as far as `Server closed
connection`, then appears to stop before logging `Session ended; reconnecting`.

### 2. The recent Caddy/Web view work made this failure more likely

Caddy itself is not required for the bug in the daemon cleanup path. A server
close over direct `ws://localhost:3000/ws` would hit the same branch.

The Caddy + Web view setup likely changed the operating conditions:

- the daemon is now commonly connected through `wss://localhost:3443/ws`
- browser Web views create more localhost proxy traffic through the daemon
- Vite/HMR pages create long-lived `proxy_ws_open` sessions
- those long-lived WebSocket proxy tasks hold cloned `TransportSender` values

So sleep/resume now more often combines:

1. a server/Caddy close after the machine wakes
2. one or more long-lived proxy tasks still holding the old transport sender
3. daemon session cleanup waiting forever for the writer task

### 3. Proxy tasks are not tied to a daemon transport generation

`ProxyManager` tracks active HTTP streams and WebSocket sessions by stream/session
id. It can react when the service sends `stream_reset`, `proxy_ws_close`, or
`proxy_ws_error`. It does not have a method for "the daemon control transport is
gone; cancel every active local proxy task for this old transport."

That matters because once the control WebSocket closes, the service can no
longer send resets over that same transport. Waiting for service-driven cleanup
is therefore insufficient.

### 4. Terminal output watchers are explicitly cleaned up, but proxy/file work is not

`TerminalManager::clear_sender()` drains session handles and aborts terminal
output watchers, so terminal sender clones are removed from the old transport.

The run executor only clears its stored sender; it may still have active legacy
run tasks, but the recent Caddy/Web view correlation points more strongly at
proxy WebSocket tasks.

Proxy and file managers do not currently mirror terminal's explicit
transport-disconnect cleanup.

### 5. The service-side gateway appears generation-aware now

The service WebSocket gateway uses active-tracker guardrails:

- replacing a tracker clears the old timeout
- close/timeout cleanup only deletes the session if the tracker is still
  current
- stale close/timeout paths are ignored

Relevant code:

- `service/src/ws/session-trackers.ts`
- `service/src/ws/bud-connection.ts:809`
- `service/src/ws/bud-connection.ts:882`
- `service/src/ws/bud-connection.ts:904`

That reduces confidence that the current failure is the older service-side
stale tracker bug documented in `debug/staging-false-bud-offline-terminal-503s.md`.

### 6. The mkcert trust issue is already addressed

`Cargo.toml` now uses native-root TLS features for both `reqwest` and
`tokio-tungstenite`, matching the previous mkcert debug recommendation.

Relevant code:

- `bud/Cargo.toml`

The observed daemon log also proves the daemon had already connected and reached
the session loop, so this is not a certificate validation failure.

## Hypotheses

### 1. Primary: close cleanup blocks on the writer task because proxy WebSocket tasks keep old senders alive

Confidence: high.

Mechanism:

1. Web view/HMR opens a local WebSocket proxy session.
2. `ProxyManager::handle_ws_open(...)` spawns a task holding a cloned
   `TransportSender`.
3. Machine sleeps; service/Caddy closes the daemon WebSocket.
4. Daemon read loop logs `Server closed connection frame=None`.
5. Daemon clears run/terminal sender state and drops its local sender.
6. The proxy WebSocket task still owns a sender clone.
7. The writer task's channel remains open.
8. `run_session(...)` awaits the writer task forever.
9. The outer reconnect loop never logs `Session ended; reconnecting` and never
   starts a new WebSocket.

### 2. Secondary: HTTP/file streams waiting for credit can produce the same stall

Confidence: medium.

HTTP proxy and file read tasks can wait on service credit channels. If the
control transport closes before the service sends reset/credit/close, those
tasks can also keep a sender clone alive.

This is probably less common than HMR WebSocket sessions, but the ownership
problem is the same.

### 3. Secondary: Caddy is a trigger, not the root cause

Confidence: medium-high.

Caddy may close idle or broken upstream/downstream connections after sleep, or
it may simply surface the service-side close cleanly. That should be okay. The
daemon's reconnect contract still requires the close path to unwind old
transport work and return to the outer loop.

### 4. Secondary: half-open sockets without a close frame can still delay reconnect

Confidence: medium.

The daemon has heartbeat writes, but heartbeat sends first enqueue into the
writer channel. If the read half never observes close/error and the OS accepts
writes for a while after sleep, detection may still be delayed.

This is a separate hardening area. It does not explain this specific log as
strongly because the daemon did receive `Message::Close`.

## Proposed Fix Direction

No code changes were made in this pass.

The minimal robust fix should make the daemon transport-disconnect path
generation-aware and non-blocking:

1. Add explicit disconnect cleanup for proxy/file managers.
   - Cancel all active proxy HTTP streams for the old transport.
   - Cancel all active proxy WebSocket sessions for the old transport.
   - Cancel all active file streams for the old transport.
   - Remove their event-channel entries so tasks stop waiting for service
     events that can no longer arrive.

2. Do not let reconnect depend on old writer-task channel closure.
   - After read-side close/error, drop/clear local senders and abort the writer
     task, or time-bound the `writer_handle.await`.
   - The old connection is already closed; reconnect should be preferred over
     graceful draining of a dead transport.

3. Consider tagging long-lived daemon work with a transport/session generation.
   - Old proxy/file tasks should not be able to write to or keep alive a
     superseded transport.
   - New sessions should get fresh managers or generation-scoped cancellation
     tokens.

4. Add focused regression coverage.
   - Simulate a `proxy_ws_open` task that holds a sender clone.
   - Feed `Message::Close(None)` to the daemon session.
   - Assert the session returns and the outer reconnect loop can continue.
   - Add equivalent coverage for a proxy/file stream waiting on credit.

## Validation Plan

Before changing code, confirm the stall point with logs:

1. Enable `BUD_DEBUG=true`.
2. Reproduce sleep/resume while a Web view with HMR is open.
3. Check for absence of `Session ended; reconnecting` after
   `Server closed connection`.
4. Add temporary local instrumentation around:
   - immediately before awaiting `writer_handle`
   - immediately after awaiting `writer_handle`
   - active proxy stream/session counts
5. Repeat without an active Web view/HMR session.
   - If reconnect succeeds without active proxy sessions, this strongly confirms
     sender-retention by proxy tasks.
6. Repeat with direct `ws://localhost:3000/ws`.
   - If the direct path can still stall with active proxy tasks, Caddy is only
     a trigger.

## Files Likely Affected If Fixed

- `bud/src/app.rs`
- `bud/src/proxy/mod.rs`
- `bud/src/files/mod.rs`
- `bud/src/src.spec.md`
- `bud/src/proxy/proxy.spec.md`
- `bud/src/files/files.spec.md`
- `bud/bud.spec.md`
