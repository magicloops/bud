# Debug: agent-and-terminal-sse-request-storm

## Environment
- Date: 2026-03-19
- Local development on macOS
- Service running on `http://localhost:3000`
- Web running on `http://localhost:5173`
- Browser already authenticated with Bud
- Bud daemon connected and thread page opened for an existing thread
- Current branch includes recent mobile-auth readiness work and new `/api/me/*` routes

## Repro Steps
1. Start the service and web app locally.
2. Open an existing thread in the web UI.
3. Watch the service logs immediately after the thread page mounts.

## Observed
- The service receives a continuous stream of:
  - `GET /api/threads/:threadId/agent/stream`
  - `GET /api/threads/:threadId/terminal/stream`
  - `POST /api/threads/:threadId/terminal`
  - `GET /api/me`
- All of these requests return `200`.
- The SSE logs are especially suspicious:
  - `SSE listener attached`
  - `request completed`
  - `SSE listener detached`
  - all within the same millisecond window
- `terminal/stream` and `agent/stream` both show `buffered: 0` at attach time.
- The terminal endpoint `POST /api/threads/:threadId/terminal` is being hit far more often than a normal reconnect backoff should allow.

## Expected
- `GET /api/threads/:threadId/agent/stream` should stay open until the browser navigates away, loses auth, or the connection genuinely drops.
- `GET /api/threads/:threadId/terminal/stream` should stay open and deliver heartbeats/output.
- `POST /api/threads/:threadId/terminal` should happen once per mount or deliberate reconnect cycle, not continuously.
- `GET /api/me` should happen during normal app boot and occasional auth checks, not in a tight loop.

## Implementation Review

### SSE route behavior
- `service/src/routes/threads.ts` attaches listeners for both thread SSE routes:
  - `GET /api/threads/:threadId/agent/stream` at lines 452-477
  - `GET /api/threads/:threadId/terminal/stream` at lines 596-627
- In both routes, the handler:
  1. calls `agentEvents.attach(...)` or `terminalEvents.attach(...)`
  2. schedules the first heartbeat with `setInterval(...)`
  3. returns without sending an immediate SSE frame

### Event bus behavior
- `service/src/runtime/event-bus.ts` only calls `reply.sse(...)` when replaying buffered events or when a later emitted event arrives.
- If the buffer is empty, `attach(...)` logs the attachment but does not prime the stream.

### Fastify SSE plugin behavior
- `service/node_modules/fastify-sse-v2/lib/plugin.js` initializes SSE headers and the internal stream only on the first `reply.sse(...)` call.
- That means an SSE route that attaches listeners but never sends an initial frame can return before the stream is actually established.

### Thread view terminal behavior
- `web/src/routes/$budId/$threadId.tsx` mounts the terminal flow in the main terminal SSE effect around lines 738-1077.
- `connect()` does:
  1. `POST /api/threads/:threadId/terminal`
  2. open `EventSource('/api/threads/:threadId/terminal/stream')`
- If that EventSource closes, `source.onerror` triggers reconnect handling around lines 989-997.

### Thread view recovery behavior
- The disconnected recovery effect at lines 1021-1077 treats `POST /api/threads/:threadId/terminal` as a service recovery probe.
- But the service route at `service/src/routes/threads.ts` lines 500-534 is explicitly DB-only and designed to succeed whenever the thread exists, regardless of Bud online status.
- So this recovery loop is not a real transport/SSE health check.

### Auth-aware EventSource behavior
- `web/src/lib/api.ts` lines 207-229 define `createAuthEventSource(...)`.
- `checkUnauthorized()` performs `GET /api/me` whenever the `EventSource` is already `CLOSED`.
- Once SSE starts failing immediately, every error callback can produce another `/api/me` request.

## Hypotheses

### 1. Primary cause: the SSE routes do not prime the stream before returning
Most likely root cause.

Evidence:
- service logs show `request completed` immediately after `SSE listener attached`
- `buffered: 0` means `event-bus.attach(...)` does not call `reply.sse(...)`
- `fastify-sse-v2` only sets up the actual SSE response on the first `reply.sse(...)`

Consequence:
- the browser sees a `200` response that closes immediately
- `EventSource` errors/reconnects
- both agent and terminal streams churn forever

### 2. Secondary amplifier: the terminal recovery loop uses the wrong liveness probe
Very likely.

Evidence:
- `pollAndReconnect()` calls `POST /api/threads/:threadId/terminal`
- that endpoint is DB-only and intended to return `200` whenever the thread exists
- on success, the effect increments `sseReconnectTrigger` immediately

Consequence:
- once terminal state enters `reconnecting` or `offline`, the client can force immediate new connect cycles even though the SSE path itself is still broken
- this explains the storm of `POST /api/threads/:threadId/terminal`

### 3. Secondary amplifier: auth probing turns every failed SSE attempt into `/api/me`
Very likely.

Evidence:
- `createAuthEventSource.checkUnauthorized()` calls `/api/me` whenever `source.readyState === CLOSED`
- the logs show `/api/me` interleaved with stream churn
- the `/api/me` responses are `200`, so this is not a real auth failure loop

Consequence:
- a stream lifecycle bug becomes a mixed SSE + auth request storm
- the new `/api/me` work looks suspicious in logs even if it is not the root cause

### 4. Both stream types are affected independently
Likely.

Evidence:
- `/agent/stream` and `/terminal/stream` both show immediate attach/complete/detach
- both routes follow the same structural pattern: attach listener, start delayed heartbeat, return

Consequence:
- even if one reconnect path were fixed, the other could still churn
- the total request volume is the combination of two failing stream loops plus auth checks

### 5. The recent `/api/me/*` route additions are probably not the primary regression
Likely.

Evidence:
- the problem reproduces as successful `200` responses, not failed auth
- the `/api/me` traffic lines up with the generic `checkUnauthorized()` helper
- the more distinctive defect is the immediate close of both SSE routes

Consequence:
- the correct fix target is SSE lifecycle and reconnect behavior first
- `/api/me` should be treated as collateral traffic unless later evidence says otherwise

## Proposed Fix
- Server: prime SSE immediately in `/api/threads/:threadId/agent/stream` and `/api/threads/:threadId/terminal/stream`, or move that priming into `event-bus.attach(...)`, so the response is converted into a live SSE stream before the handler returns.
- Client: stop using `POST /api/threads/:threadId/terminal` as the disconnected-service probe; use a real service health signal or a pure reconnect timer instead.
- Client: keep the auth check on failed SSE conservative; avoid calling `/api/me` on every closed-source error when the failure is clearly transport/lifecycle-related.

## Resolution
- Implemented server-side SSE priming in `service/src/runtime/event-bus.ts` so empty-buffer attaches send an initial heartbeat frame immediately.
- Removed the closed-stream `/api/threads/:threadId/terminal` polling loop from the thread view in `web/src/routes/$budId/$threadId.tsx`.
- Terminal reconnects now stay on the main exponential-backoff path, while the separate recovery poll is reserved for the narrower case where the SSE stream is still open but the Bud is offline.

## Current Validation
- After the patch, the previously observed request storm appears resolved in local testing.
- The issue is no longer considered a blocker for returning to the mobile-auth Phase 3 runtime checklist.

## Spec Files Affected If Fixed
- `service/src/runtime/runtime.spec.md`
- `service/src/routes/routes.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `web/src/lib/lib.spec.md`
