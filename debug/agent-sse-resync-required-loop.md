# Debug: agent-sse-resync-required-loop

## Environment
- Date: 2026-05-25
- Workspace: `/Users/adam/bud`
- Runtime under investigation: local web app against local service at `localhost:3443`
- Browser scenario: an already-open site tab repeatedly calls `GET /api/threads/:threadId/agent/stream?after=...`
- Investigation mode: static code review plus an attempted in-app browser inspection; no code changes were made

## Repro Steps
1. Keep an existing Bud web thread tab open.
2. Let the tab continue running after the agent stream cursor becomes stale, such as after a service restart or after the server's process-local replay buffer ages out.
3. Watch service logs for repeated `GET /api/threads/:threadId/agent/stream?after=<same cursor>`.

## Observed
- The service logs show repeated requests roughly every 3 seconds:
  - `/api/threads/88cfd94c-3b6a-4087-b334-a8252399bf5e/agent/stream?after=01KSE38CZ7C29PDRMK37416STE`
  - `Agent SSE attach requires resync`
  - `statusCode: 200`
- The `after` cursor stays identical across retries.
- The server completes each response in about 5 ms.
- No corresponding sample log shows a successful `/agent/state` or `/messages` bootstrap refresh between the repeated stream attaches.

## Additional Browser Evidence
- Follow-up browser logs show a tight repeat of:
  - `[agent-sse] connected { threadId, after: "01KSGJKB9M7YDT9B17K9X90WEC" }`
  - `[agent-sse] error { readyState: 0, evt: Event }`
- `readyState: 0` is `EventSource.CONNECTING`, not `EventSource.CLOSED`.
- The current error handler logs this state, then returns without closing the source or scheduling Bud's manual reconnect because `source.readyState !== EventSource.CLOSED` in `web/src/features/threads/use-agent-stream.ts:473-481`.
- The browser logs do not show `[agent-sse] explicit resync required`, so the client-side `agent.resync_required` listener in `web/src/features/threads/use-agent-stream.ts:414-437` is either not receiving the event or not getting a chance to run before the native reconnect cycle continues.
- The service-restart / frontend-HMR trigger fits the cursor model: service restart loses the process-local replay buffer, while HMR or a preserved tab can keep the old in-memory `cursorRef.current`.

## Expected
- A stale or unknown cursor should produce one explicit `agent.resync_required` event.
- The web client should then refresh `/messages` and `/agent/state`, replace its local cursor with the fresh `stream_cursor`, and reconnect with the new cursor.
- The same stale `after` cursor should not be retried indefinitely.

## Implementation Review

### Server bounded-resume behavior is working as designed
- `AgentRuntimeStateManager` keeps a process-local bounded replay buffer with `DEFAULT_BUFFER_TTL_MS = 60_000` in `service/src/runtime/agent-runtime-state.ts:81`.
- Resume attach only succeeds when the supplied cursor is still present in that buffer; otherwise `prepareAttachment(...)` returns `resync_required` at `service/src/runtime/agent-runtime-state.ts:363-369`.
- The route reads a resume cursor from `Last-Event-ID`, `after`, or `last_event_id` in `service/src/routes/threads/agent.ts:145-149`.
- On a resume miss, the route sends `agent.resync_required` and immediately closes the raw response in `service/src/routes/threads/agent.ts:154-163`.

This means the log line itself is not a backend bug. A stale cursor after buffer TTL expiry or service restart is a normal condition.

### Client resync path should converge, but the log sample suggests it is not firing or not succeeding
- `useAgentStream(...)` builds the stream URL from `cursorRef.current` in `web/src/features/threads/use-agent-stream.ts:194-198`.
- Its `agent.resync_required` handler should call route-owned `refreshBootstrap(...)`, set `cursorRef.current = nextAgentState.stream_cursor`, and reconnect in `web/src/features/threads/use-agent-stream.ts:414-437`.
- The route's `refreshAgentBootstrap(...)` refetches `/messages` and `/agent/state`, then writes the new cursor back through `agentStreamCursorSetterRef` in `web/src/routes/$budId/$threadId.tsx:248-258`.

If that path runs successfully, the next stream request should not use `01KSE38CZ7C29PDRMK37416STE` again.

### The retry cadence and browser readyState point at native EventSource behavior
- The repeated requests are about 3.0 seconds apart: `13:18:33.781`, `13:18:36.787`, `13:18:39.803`.
- That cadence is much closer to browser-managed `EventSource` retry timing than to Bud's explicit reconnect path, which starts at 500 ms and ramps to 5 seconds.
- The URL keeps the original `?after=...` query, which is exactly what native EventSource reconnects reuse when the application has not closed the source and created a new one with a refreshed cursor.
- The browser-reported `readyState: 0` matches the code path where Bud intentionally lets native EventSource retry continue instead of manually reconnecting.

## Browser Check
- I attempted to inspect the in-app browser, but it had only an `about:blank` selected tab and no open user tabs exposed through that browser surface.
- That means this note does not include live DevTools confirmation from the actual tab producing the service logs.

## Top Hypotheses

### 1. Strongest: native EventSource retry is reusing the stale URL after a restart-created resume miss
The server sends `agent.resync_required` and closes the stream immediately. If the browser does not deliver the custom event to the React handler before treating the stream as closed, the native EventSource retry loop reopens the same URL with the same `?after=` cursor every ~3 seconds.

Why it fits:
- same stale cursor every time
- response closes immediately with `200`
- retry interval is ~3 seconds
- browser error logs show `readyState: 0`, which is exactly the path where the current client code defers to native retry
- no sign in the provided logs that the app received `agent.resync_required` or performed the intended bootstrap refresh

### 2. Strong: service restart resets the replay buffer while the tab preserves an old cursor
After service restart, `AgentRuntimeStateManager` starts with an empty/new process-local buffer. The old tab still has `cursorRef.current` from the previous process. The next attach with `?after=<old cursor>` must miss and require resync.

Why it fits:
- the user suspects service restart and/or HMR
- bounded resume is intentionally process-local and only retained for 60 seconds
- the stale cursor value stays stable across the browser's native reconnect loop

Why this is not the whole bug:
- a resume miss is expected; the failure is that the tab does not converge through bootstrap refresh

### 3. Medium: the client receives resync but bootstrap refresh fails, leaving the stale cursor in place
The `agent.resync_required` handler suppresses the normal `error` reconnect path, then calls `refreshBootstrap(...)`. If that refresh fails, `scheduleReconnect('resync_refresh_failed')` reconnects with the still-stale `cursorRef.current`.

Why it fits:
- it explains repeated stale `after` values if `/agent/state` is failing, unauthorized, or blocked

Why it is weaker:
- the observed cadence is closer to native EventSource retry than the hook's own 500 ms to 5 s reconnect schedule
- the browser logs do not show the `explicit resync required` log that precedes the bootstrap refresh

### 4. Medium: a stale/HMR-preserved hook or tab instance is still alive without the current resync handler state
There is prior history in `debug/agent-sse-stale-tab-reconnect-loop.md` of stale tabs and manual/native reconnect overlap. A development tab that survived HMR or service restarts could own an EventSource created with an old cursor and fail to converge if its handler state is stale.

Why it fits:
- user specifically points to an already-open tab
- the current symptom is similar to the prior stale-tab class, but now at the bounded-resume miss boundary

### 5. Lower: server closes the resync frame too quickly for some browser/proxy combinations
The route calls `reply.sse(...)` and then `reply.raw.end()` immediately for resync misses. If the HTTPS dev proxy or browser sometimes treats the connection as ended before dispatching the custom event to JS, the app never runs the explicit resync handler.

Why it fits:
- the server-side response time is only ~5 ms
- the failed behavior would degrade into native EventSource retry with the original URL
- browser logs show open/error without the explicit resync log

## Current Read
The server log is best read as a stale resume cursor being rejected correctly after service restart or replay-buffer expiry, followed by native EventSource retry reusing the same stale URL. The browser `readyState: 0` evidence makes the native retry hypothesis stronger than the failed-bootstrap hypothesis. The most likely root is not a backend listener leak and not a failure of the bounded-resume contract; it is that the client does not take ownership of recovery when EventSource opens and then quickly errors in `CONNECTING` state without delivering `agent.resync_required`.

## Suggested Next Validation
1. In the affected browser tab, check console logs for:
   - `[agent-sse] explicit resync required`
   - `[agent-sse] failed to refresh bootstrap after resync`
   - `[agent-sse] connected`
2. In the Network tab, inspect one `/agent/stream?after=...` response and verify whether the `agent.resync_required` event appears in the EventStream panel before the connection closes.
3. Watch service logs for `GET /api/threads/:id/agent/state` and `GET /api/threads/:id/messages` immediately after a resync-required response.
4. If the browser never logs `explicit resync required`, focus on EventSource native retry and response-flush behavior.
5. If the browser logs the resync but then logs `failed to refresh bootstrap after resync`, focus on why the bootstrap request fails and why reconnects reuse the stale cursor.

## Possible Fix Directions
- Client-owned quick-close recovery: when an EventSource opens and then errors in `CONNECTING` state while `cursorRef.current` is non-null, close it, refresh `/messages` + `/agent/state`, replace the cursor, and create a fresh source. This directly targets the observed open/error loop without waiting for the custom resync event.
- Clear stale cursor before any resync-recovery retry. If bootstrap refresh fails, the next reconnect should not reuse a cursor already known to be invalid; either pause, retry bootstrap, or reconnect live-only with clear UI state.
- Server delivery hardening: keep the current resync contract but verify whether `agent.resync_required` is reliably visible in the browser EventStream panel. If it is not, consider an explicit flush/delayed close or a response shape such as `204` plus client-side closed/error handling for stale cursor recovery.
- Transport ownership: replace native `EventSource` for the agent stream with a fetch-based SSE reader so the app owns reconnect timing, HTTP status handling, and stale-cursor recovery. This is larger but removes the native retry blind spot.
- Development/HMR guard: on module refresh or service-restart detection, invalidate the old cursor and force a bootstrap refresh before reconnecting. This is narrower but may leave production restart edges less covered.
- Add short-term diagnostics around resync: log client receipt, quick-close detection, bootstrap refresh start/success/failure, refreshed cursor, next stream URL, and whether the recovery path was native retry or Bud-owned reconnect.

## Files Reviewed
- `service/src/routes/threads/threads.spec.md`
- `service/src/runtime/runtime.spec.md`
- `web/src/features/threads/threads.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/routes/threads/agent.ts`
- `service/src/routes/threads/shared.ts`
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/features/threads/thread-stream-timing.ts`
- `web/src/features/threads/use-thread-messages.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/lib/transport.ts`
- `debug/agent-sse-stale-tab-reconnect-loop.md`
- `debug/agent-and-terminal-sse-request-storm.md`
- `debug/agent-stream-state-and-resume-implementation.md`
