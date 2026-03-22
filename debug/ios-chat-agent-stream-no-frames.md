# Debug: iOS Chat Agent Stream Opens But Delivers No Parsed Frames

## Environment

- Local service process on `http://localhost:3000`
- Local public/mobile origin on `http://localhost:5173` via Vite proxy
- Mobile auth mode: bearer token
- Stream under investigation: `GET /api/threads/:thread_id/agent/stream`
- Known-good comparison path: web dev UI uses the same route through `5173` with browser `EventSource`

## Repro Steps

1. Open an existing owned thread in the iOS app.
2. Send a message with `POST /api/threads/:thread_id/messages`.
3. Confirm the write succeeds and immediate REST refreshes succeed.
4. Open or reopen `GET /api/threads/:thread_id/agent/stream` through `http://localhost:5173`.
5. Observe that the response is `200` with `content-type: text/event-stream`, but the iOS client logs no parsed SSE events during the captured window.

## Observed

From the mobile checklist:

- `POST /api/threads/:thread_id/messages` succeeds
- `GET /api/threads/:thread_id` succeeds
- `GET /api/threads/:thread_id/messages?limit=200` succeeds
- `GET /api/threads/:thread_id/agent/stream` succeeds with `200 text/event-stream`
- bearer auth is present on the stream request
- there are no redirects
- iOS reports no parsed SSE frames after the connection opens

## Expected

Given the current backend implementation, a successfully attached stream should observe at least one of these outcomes:

- an immediate priming `heartbeat` if the per-thread agent buffer is empty
- replayed buffered events if the thread already has buffered agent events
- periodic `heartbeat` events every `1000ms` in local dev, even if the agent has not emitted turn activity yet
- live `agent.tool_call`, `agent.tool_result`, `agent.message`, and `final` events while the turn is running

A clean `200 text/event-stream` response with zero frames is therefore not consistent with the intended route behavior.

## Current Implementation Findings

### 1. The stream is thread-scoped and uses an in-memory replay buffer

`service/src/routes/threads.ts` attaches the stream to `AgentEventBus` using `threadId` as the channel key. `service/src/runtime/event-bus.ts` replays buffered events on attach.

Implication:

- replay is per-thread, in-memory, and local to the current service process
- replay is not persisted in the database
- replay is available only while the current process still holds buffered events for that thread

### 2. Empty attaches are explicitly primed with a heartbeat

`AgentEventBus.attach(...)` sends an immediate `heartbeat` frame when the buffer is empty so the SSE response enters streaming mode before the route returns.

Implication:

- if the route authorizes and reaches `attach(...)`, a compliant client should usually see a frame immediately even before the first agent event
- the absence of all parsed frames points away from a simple “agent had nothing to say yet” explanation

### 3. The route also emits periodic heartbeats

`GET /api/threads/:thread_id/agent/stream` sets a heartbeat interval of `1000ms` in dev and `5000ms` in production.

Implication:

- even after the initial attach, a quiet but healthy local stream should still produce heartbeats every second

### 4. The backend emits exactly the event names the mobile team expects

`service/src/agent/agent-service.ts` emits only:

- `agent.tool_call`
- `agent.tool_result`
- `agent.message`
- `final`

Together with the route/event-bus heartbeats, the full expected event set is:

- `heartbeat`
- `agent.tool_call`
- `agent.tool_result`
- `agent.message`
- `final`

Implication:

- undocumented event names are not a strong explanation for “no parsed frames at all”

### 5. The event buffer is cleared at the start of each new send

`AgentService.startUserMessage(...)` calls `this.events.clearBuffer(threadId)` before starting the next run.

Implication:

- replay is intentionally best-effort for the current turn only
- a reconnect shortly after `POST /messages` should still usually replay current-turn events
- a reconnect after a later send, a process restart, or an explicit buffer clear cannot rely on old events still existing

### 6. The current web app also restarts the agent stream after send

`web/src/routes/$budId/$threadId.tsx` closes any existing agent stream after a successful `POST /messages` and reconnects immediately. It also refetches `/messages` on reconnect and on `final`.

Implication:

- “restart the stream after send” is not inherently incompatible with the backend contract
- this lowers the probability that iOS restart-after-send is the sole root cause
- the main remaining differences are native client behavior, bearer-header handling, and the `5173` proxy path

### 7. Existing backend logs are helpful but not sufficient

`service/src/runtime/event-bus.ts` logs:

- `SSE listener attached`
- `SSE event emit`

But those logs occur before or around `reply.sse(...)`, and write failures are swallowed by the event-bus emit loop.

Implication:

- current logs can prove that the server tried to attach and emit on a thread channel
- current logs cannot prove that a specific mobile connection actually received and flushed the bytes successfully

## Hypotheses

### Hypothesis 1: `5173` opens the SSE response but does not flush frames cleanly to the native client

**Confidence:** High

Why:

- the route should emit an immediate heartbeat on empty attach
- the route should emit periodic heartbeats every second in local dev
- iOS reports zero parsed frames despite a successful `200 text/event-stream` response
- the main path difference from the working web client is the native streaming stack, not the high-level endpoint

What would confirm it:

- raw chunked SSE frames appear when hitting `3000` directly but stall or disappear through `5173`

### Hypothesis 2: The exact mobile connection is attaching, but writes to that connection are failing or closing before first delivery

**Confidence:** Medium-high

Why:

- the current route/event-bus code has no request-scoped “write succeeded” logging
- write failures inside listener delivery are swallowed to avoid disconnect spam
- a connection-specific failure could produce “200 open stream, no frames parsed” without disproving that the thread had events

What would confirm it:

- request-scoped SSE logging shows attach occurred, `reply.sse(...)` was attempted, and the socket closed or errored before/while frames were written

### Hypothesis 3: iOS replacement-stream timing is interacting badly with a best-effort replay contract

**Confidence:** Medium

Why:

- replay is only in-memory and tied to the current service process
- the buffer is cleared at the start of each new send
- iOS appears to abandon its existing stream and depend on the replacement stream

Why this is not the leading explanation:

- the web client performs the same close-and-reconnect pattern after send
- the backend does buffer current-turn events for replay
- this does not explain the more specific symptom of seeing no heartbeat frames at all

What would confirm it:

- keeping the original stream alive receives frames, but a deliberately reattached stream sometimes misses the turn despite the route being otherwise healthy

### Hypothesis 4: The backend event contract is correct, but the native client is not surfacing raw SSE frames to the parser

**Confidence:** Medium

Why:

- event names and route behavior match the documented contract
- browser `EventSource` is the known-good consumer
- native `URLSession`-style streaming may differ in buffering, delimiter handling, or dispatch timing

What would confirm it:

- raw bytes are present at the iOS socket layer or in a non-browser client test, but the iOS parser still reports zero events

### Hypothesis 5: Event-name or payload-shape drift is causing the iOS decoder to drop events silently

**Confidence:** Low

Why:

- current event names match the mobile team’s expected set
- shape drift would more likely drop specific event decodes, not all heartbeats plus all turn events

What would confirm it:

- raw SSE frames are definitely arriving, but the parser rejects every event payload

## Verification Plan

### 1. Confirm what the current logs already tell us

For a failing thread id, capture:

- `SSE listener attached` with `channelId=<thread_id>` and buffered count
- `SSE event emit` entries for the same `channelId`
- request start and close timing for `GET /api/threads/:thread_id/agent/stream`

This will answer:

- whether the route authorized and attached
- whether the thread channel actually emitted `heartbeat` or agent events during the failing window

This will **not** yet answer:

- whether the exact mobile connection successfully received those frames

### 2. Add temporary request-scoped SSE diagnostics

Instrument `GET /api/threads/:thread_id/agent/stream` and/or `AgentEventBus.attach(...)` with a per-connection id and log:

- request start
- thread id
- auth mode / resolved viewer id
- attach buffer length
- initial heartbeat attempted
- periodic heartbeat attempted
- each event name attempted for that specific connection
- whether `reply.raw.writableEnded` or `reply.raw.destroyed` was already true
- any `reply.sse(...)` throw
- socket close timing

This is the fastest way to distinguish:

- “thread had events”
- “this connection was written to”
- “this connection closed before delivery”

### 3. Compare direct service vs public-origin streaming with non-browser clients

Run the same stream test against:

- `http://localhost:3000/api/threads/:thread_id/agent/stream`
- `http://localhost:5173/api/threads/:thread_id/agent/stream`

Use:

- `curl -N` with bearer auth
- a minimal Node client that reads raw chunks progressively

Success criteria:

- immediate heartbeat on empty attach
- progressive heartbeats while idle
- live or replayed agent events after send

Interpretation:

- `3000` works, `5173` stalls: proxy/local-public-origin issue
- both work outside iOS: native client parsing/dispatch issue
- both fail: backend route or Fastify SSE behavior issue

### 4. Run a controlled replay/reattach matrix

For one thread and one send:

1. attach stream before send
2. send message
3. record frames on the original connection
4. close and reattach after `50ms`
5. repeat after `250ms`
6. repeat after `1000ms`
7. repeat after the turn completes

For each attach, record:

- whether the attach got an immediate heartbeat
- whether buffered `agent.tool_call`, `agent.tool_result`, `agent.message`, and `final` replayed
- whether replay disappears after a later send or process restart

This will validate the real replay contract instead of inferring it.

### 5. Compare the working web path with the failing mobile path

Capture and compare:

- request URL
- request headers
- auth mode
- whether the stream is opened before send, after send, or both
- how long the pre-send connection stays alive

Important existing finding:

- web currently closes and recreates the agent stream after a successful send, so mobile is not inherently “wrong” to do the same

### 6. If backend/proxy look healthy, ask iOS for raw-byte evidence instead of parsed-event evidence

The most useful mobile-side follow-up is:

- log raw byte chunks received from the stream before SSE parsing
- log the exact framing boundaries seen by the native client

That will cleanly separate:

- “server never flushed bytes”
- from “bytes arrived but the parser never turned them into events”

## Likely Next Actions Based On Results

- If `3000` streams and `5173` does not: fix or bypass the local proxy path for native SSE debugging.
- If both `3000` and `5173` stream to `curl`/Node but not iOS: inspect the iOS SSE parser and raw-byte handling.
- If request-scoped logs show no successful writes for the mobile connection: fix backend SSE write/flush behavior and keep the extra diagnostics until mobile confirms receipt.
- If reattach tests show replay gaps for the current-turn buffer: tighten the replay contract or change mobile to keep the original stream alive through the turn.

## Conclusion

The checklist correctly narrows the issue away from basic REST auth and message creation. The strongest current backend reading is:

- the route is supposed to produce heartbeat frames almost immediately
- the backend already emits only the documented agent event names
- web uses a very similar restart-after-send pattern and still works

That makes a pure “mobile is restarting the stream wrong” explanation too weak on its own. The next debugging step should focus on proving whether the exact mobile connection is actually receiving flushed bytes through `5173`, rather than only whether the route returned `200 text/event-stream`.
