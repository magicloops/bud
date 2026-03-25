# Debug: staging false Bud-offline / terminal `503` recovery loop

## Environment
- Date: 2026-03-24
- Deployment shape: Render `bud-web` + Render `bud-service` behind `https://staging.bud.dev`
- Edge routing: Cloudflare Worker on `staging.bud.dev` for `/api/*`, `/.well-known/*`, `/ws`, `/readyz`, and `/healthz`
- Browser surface: web app on `https://staging.bud.dev`
- Daemon surface: Bud daemon connected through `wss://staging.bud.dev/ws`

## Repro Steps
1. Sign in to `https://staging.bud.dev`.
2. Connect a Bud daemon and confirm terminal streaming works.
3. Keep the thread page open long enough for the intermittent failure to occur, sometimes with an extra tab open.
4. Observe the frontend start returning repeated `503` responses from `POST /api/threads/:thread_id/terminal/ensure`.
5. Refresh the page: terminal works briefly, then flips back to `Bud offline` while the local daemon still appears connected.

## Observed
- The Bud daemon reports a live WebSocket connection locally.
- The web terminal flips into reconnect/offline state and starts retrying `terminal/ensure`.
- `POST /api/threads/:thread_id/terminal/ensure` returns `503 { error: "bud_offline" }`.
- Refreshing the page can briefly restore the terminal before the same failure returns.
- Closing an unrelated claim-flow tab appeared to help once, but the correlation was not repeatable.
- Cloudflare Worker metrics showed a noticeable number of `Cancelled` and `Response Stream Disconnected` client disconnects.

## Expected
- A Bud that still has a live daemon WebSocket should remain routable through `sendFrameToBud(...)`.
- `/api/threads/:thread_id/terminal/ensure` should not return `bud_offline` while the live daemon session is healthy.
- Extra browser tabs may create more SSE/poll traffic, but they should not be able to make a healthy Bud appear offline.

## Findings

### 1. The strongest backend failure mode is a stale session-tracker race in the WebSocket gateway

The active Bud routing table is the in-memory `sessions` map in [`service/src/ws/gateway.ts`](../service/src/ws/gateway.ts).

- `registerSession(...)` replaces the Bud entry with a new tracker and schedules a timeout: [`service/src/ws/gateway.ts:726`](../service/src/ws/gateway.ts#L726)
- `isBudOnline(...)` and `sendFrameToBud(...)` trust only that map: [`service/src/ws/gateway.ts:192`](../service/src/ws/gateway.ts#L192), [`service/src/ws/gateway.ts:197`](../service/src/ws/gateway.ts#L197)
- `scheduleTimeout(...)` later does an unconditional `sessions.delete(tracker.budId)` and marks the Bud offline: [`service/src/ws/gateway.ts:737`](../service/src/ws/gateway.ts#L737)
- `handleClose()` also does an unconditional `sessions.delete(this.state.budId)` and then suspends sessions / emits `terminal.bud_offline`: [`service/src/ws/gateway.ts:752`](../service/src/ws/gateway.ts#L752)

The risky part is that neither the timeout callback nor the close handler verifies that the tracker being cleared is still the active tracker currently stored in `sessions`.

That means an older socket can be replaced by a newer socket for the same `budId`, but:

- the old socket's timeout can still fire later, or
- the old socket's close handler can still run later,

and either path will delete the Bud's live map entry anyway.

Once that happens:

- `isBudOnline(...)` returns `false`
- `sendFrameToBud(...)` starts dropping frames
- `ensureSession(...)` returns `bud_offline` for otherwise healthy sessions: [`service/src/runtime/terminal-session-manager.ts:224`](../service/src/runtime/terminal-session-manager.ts#L224)
- the route surfaces that as `503`: [`service/src/routes/threads.ts:651`](../service/src/routes/threads.ts#L651)

This matches the observed pattern unusually well: the daemon still looks connected, a refresh briefly works, then the app flips back offline as soon as the stale tracker wins the race.

### 2. The stale-offline path has large blast radius because it actively resets terminal session state

When `handleClose()` runs, it does more than mark the Bud offline:

- clears terminal caches: [`service/src/runtime/terminal-session-manager.ts:1219`](../service/src/runtime/terminal-session-manager.ts#L1219)
- suspends ready/active/idle/creating sessions back to `pending`: [`service/src/runtime/terminal-session-manager.ts:1240`](../service/src/runtime/terminal-session-manager.ts#L1240)
- clears event buffers: [`service/src/runtime/terminal-session-manager.ts:1262`](../service/src/runtime/terminal-session-manager.ts#L1262)
- emits `terminal.bud_offline` to all attached thread streams: [`service/src/runtime/terminal-session-manager.ts:1285`](../service/src/runtime/terminal-session-manager.ts#L1285)

That is the right behavior for a real disconnect. It is destructive for a stale disconnect from an older replaced socket, because it makes the UI and session manager converge on a false-offline state.

### 3. The frontend recovery logic amplifies a false-offline state into repeated `503` traffic

The thread page reacts to `bud_offline` or `terminal/ensure` failures by moving into reconnect mode:

- `recoverTerminalSession(...)` calls `POST /api/threads/:thread_id/terminal/ensure` and treats `bud_offline` as reconnect/offline: [`web/src/routes/$budId/$threadId.tsx:643`](../web/src/routes/$budId/$threadId.tsx#L643)
- while the SSE connection is still open, the route polls `recoverTerminalSession(...)` every 2 seconds until recovery succeeds: [`web/src/routes/$budId/$threadId.tsx:1381`](../web/src/routes/$budId/$threadId.tsx#L1381)

So once the backend falsely reports the Bud offline, the frontend turns that into the visible symptom the team saw: repeated `terminal/ensure` `503`s.

### 4. There is also a smaller frontend false-reconnect risk around the terminal status timing threshold

The production terminal SSE stream sends heartbeats every 5 seconds: [`service/src/routes/threads.ts:728`](../service/src/routes/threads.ts#L728)

The frontend `handleStatus(...)` path treats a gap greater than 5 seconds since the previous SSE event as `service_restart_detected`: [`web/src/routes/$budId/$threadId.tsx:1243`](../web/src/routes/$budId/$threadId.tsx#L1243)

That threshold is brittle because it is effectively equal to the production heartbeat cadence. Any slight delay or event ordering skew can make a normal quiet period look like a restart. This does not explain the daemon-looking-connected / backend-returning-`bud_offline` symptom by itself, but it can add avoidable reconnect churn.

### 5. The extra claim-flow tab is a weak clue, not a strong root cause

The hosted claim page does poll the claim-flow endpoint every 1.5 seconds while the flow remains pending/approved: [`web/src/routes/devices.claim.$flowId.tsx:164`](../web/src/routes/devices.claim.$flowId.tsx#L164)

However, it does not subscribe to terminal SSE or directly manipulate Bud session state. That makes it a weak direct explanation for the Bud-offline transition. It may have contributed extra browser/network churn, but the current code review does not point to it as the primary cause.

### 6. The Cloudflare Worker metrics look more like symptoms of reconnect churn than the primary defect

Per the current Cloudflare Workers docs:

- `Response Stream Disconnected` means the connection terminated during deferred proxying and "commonly appears for longer lived connections such as WebSockets"
- `Cancelled` means the client disconnected before the Worker completed its response

Source: [Cloudflare Workers errors and exceptions](https://developers.cloudflare.com/workers/observability/errors/)

Given Bud's use of long-lived SSE and WebSocket traffic, some amount of those metrics is expected during refreshes, reconnects, tab closes, and stream restarts. They are still useful signals, but they do not by themselves prove the Worker is the origin of the bug.

## Hypotheses
1. A replaced WebSocket session for the same `budId` is later timing out or closing, and its stale cleanup path is deleting the newer active session from the shared `sessions` map.
2. After that stale cleanup fires, terminal-session suspension plus emitted `terminal.bud_offline` events push the web UI into a false disconnected state even though the daemon is still connected on the newer socket.
3. The frontend reconnect loop then keeps hitting `/api/threads/:thread_id/terminal/ensure`, producing the repeated `503` pattern.
4. Separate from the main bug, the `> 5000 ms` `handleStatus(...)` threshold may be causing extra reconnect attempts in production.
5. The claim-flow tab and Cloudflare disconnect metrics are probably secondary churn indicators, not the underlying root cause.

## Proposed Fix
- Make WebSocket session ownership generation-aware in [`service/src/ws/gateway.ts`](../service/src/ws/gateway.ts):
  - when registering a new session for a `budId`, clear any prior tracker's timeout
  - in timeout and close paths, only delete the Bud from `sessions` if the current map entry still matches that tracker/session/socket
  - only emit offline/suspend side effects for the active tracker
- Add gateway logs that include `budId`, `sessionId`, and whether the tracker being closed/timed out is still current.
- After the backend race is fixed, re-evaluate the frontend reconnect heuristics:
  - increase or remove the `handleStatus(...)` `> 5000 ms` restart detector
  - confirm the connected-SSE recovery loop settles cleanly instead of hammering `terminal/ensure`
- Validate with:
  - page refresh during active terminal use
  - two or more browser tabs on the same Bud/thread
  - forced daemon reconnect while the thread page is open
  - Cloudflare Worker metrics/logs during SSE and `/ws` reconnects

## Spec Files Affected
- [`bud.spec.md`](../bud.spec.md) for root debug-doc indexing only
