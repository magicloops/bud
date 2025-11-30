# Debug: Bud fails to reconnect after backend restart (no active session / terminal_input 503)

## Environment
- Bud daemon: tmux-enabled, running locally on macOS.
- Backend service: Node/TS, hot-reloaded (code edits restart server).
- Web UI: sends terminal input via REST.

## Repro steps
1. Run Bud and backend; terminal works normally.
2. Trigger backend restart (code edit reload).
3. After restart, send terminal input via UI: service logs show `No active session for bud; dropping frame` and 503; Bud logs show nothing about disconnect/reconnect.

## Observed
- Service logs:
  - terminal input received and dispatch requested.
  - WS gateway: `No active session for bud; dropping frame`, terminal_manager returns 503.
- Bud daemon logs: no indication of disconnect or reconnect attempt around the restart.
- UI previously showed similar behavior when term input silently failed; likely same root cause (backend lost the session).

## Hypotheses
1. **Service restart drops WS sessions without notifying Bud**: the gateway session map is cleared, but Bud isn’t aware of the close (process restart vs graceful close), so Bud keeps the old socket open client-side until it tries to write/read and fails, leaving the backend unaware of Bud presence.
2. **Bud doesn’t auto-reconnect on server restart**: handshake loop might not detect socket closure promptly (e.g., no ping/pong, no read). If the TCP connection stays half-open, Bud won’t reconnect, so the service thinks bud offline while Bud thinks connected.
3. **Heartbeat/offline grace mismatch**: after restart, heartbeats from Bud may not be processed or are using stale sessionId, so the backend marks Bud offline, but Bud’s writer still points to the old socket and doesn’t re-handshake.
4. **Reconnect retry suppressed after write failure**: if send fails once and sender is cleared, Bud may not re-initiate the full connect loop (logic tied to read loop exit); needs confirmation.
5. **Missing error handling on server-side accept**: backend restart may not close existing sockets cleanly; Bud’s websocket client may need a ping/pong or periodic write to detect the dead connection and reconnect.

## Next actions
- Add logging in Bud websocket loop for close/error/ping/pong and for reconnect attempts after any send/receive error.
- Add server-side logging on /ws accept/close to confirm sessions are cleared on restart.
- Verify Bud sends heartbeats post-restart and that gateway tracks lastHeartbeat; inspect offline grace handling.
- Force reconnection test: kill backend, observe Bud logs, and confirm reconnect attempts and new hello/hello_ack flow; ensure sender is reset on any send/recv failure.
