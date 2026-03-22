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

### Hypothesis 1: The backend event contract is correct, but the native client is not surfacing raw SSE bytes to the parser

**Confidence:** High

Why:

- the synthetic probe route streams progressively through both `3000` and `5173`
- the real mobile `/api/threads/:thread_id/agent/stream` request now shows proxied chunks for:
  - `retry`
  - initial `heartbeat`
  - periodic `heartbeat`
  - `agent.message`
  - `final`
- the proxied request preserves the bearer token and forwarded host/proto headers correctly
- iOS still reports zero parsed events despite the upstream stream clearly producing valid SSE frames

What would confirm it:

- raw bytes are present on the iOS socket/stream delegate, but the app still emits no parsed events

### Hypothesis 2: The final hop from Vite to the native client is still behaving differently than Vite's upstream read path

**Confidence:** Medium

Why:

- Vite proxy logs prove it is receiving the upstream SSE chunks from the service
- they do not by themselves prove that the downstream mobile socket parsed or consumed them
- this is now narrower than the original “`5173` cannot stream SSE” theory because generic and real-route upstream chunking both work

What would confirm it:

- a browser or non-browser client attached to the same proxied agent route receives frames normally while iOS still does not
- or iOS raw-byte logging shows nothing arriving even though Vite logged upstream chunks

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

### Hypothesis 4: Event-name or payload-shape drift is causing the iOS decoder to drop events silently

**Confidence:** Low

Why:

- current event names match the mobile team’s expected set
- shape drift would more likely drop specific event decodes, not all heartbeats plus all turn events
- in the captured failing request, the wire events were ordinary SSE frames with named events and JSON `data:` payloads

What would confirm it:

- raw SSE frames are definitely arriving, but the parser rejects every event payload

### Hypothesis 5: Service-side write failure on the exact SSE connection

**Confidence:** Low

Why:

- request-scoped service and proxy logging now show a healthy response path for the captured request
- Vite observed the real event frames for the actual failing mobile request
- this makes a silent service-side write failure less likely than a downstream/native parsing issue

What would confirm it:

- service logs show heartbeats/events being attempted but the socket closing or erroring before Vite or the client receives them

## Verification Plan

## Early Verification Results (2026-03-22)

### 1. Direct service SSE streamed correctly during the March 22 verification pass

A temporary dev-only probe route was used during the March 22 verification pass. It emitted:

- an immediate `heartbeat`
- several timed `probe.tick` frames
- a terminal `final`

Local `curl -N` against `http://127.0.0.1:3000/api/debug/sse-probe?...` received progressive SSE frames immediately.

### 2. The local Vite proxy also streamed the probe route during that pass

Local `curl -N` against `http://localhost:5173/api/debug/sse-probe?...` also received progressive SSE frames through the proxy.

Implication:

- the broad hypothesis “Vite on `5173` cannot stream SSE at all to non-browser clients” is now weaker
- the remaining proxy suspicion is narrower: something may still differ specifically for the real authenticated agent route, but the generic local SSE transport path does work

### 3. Temporary instrumentation was used for the real retry

Service-side:

- temporary request-scoped logging captured:
  - `POST /api/threads/:thread_id/messages` start, insert, and queue points
  - agent buffer clear / session resolution
  - `agent.tool_call`, `agent.tool_result`, `agent.message`, and `final` emission points
  - agent SSE connection ids, attach/replay details, heartbeats, and close timing

Web/Vite-side:

- temporary proxy logging captured:
  - proxied thread/message request metadata
  - proxied `/api/threads/:thread_id/agent/stream` response headers
  - per-chunk stream previews for the proxied agent SSE response

Those temporary debug hooks have since been removed from the codebase after the March 22 capture.

### 4. The real mobile agent-stream request is producing valid frames

For the captured mobile request:

- `GET /api/threads/f92cb50b-a7ff-4658-9188-42aeeb0efc94/agent/stream`
- `Authorization: Bearer <access_token>`
- `Accept: text/event-stream`
- `User-Agent: Bud (unknown version) CFNetwork/3860.300.31 Darwin/24.6.0`

Vite proxy logs showed:

- request reached `localhost:5173`
- proxy forwarded to `http://localhost:3000`
- response returned `200 text/event-stream`
- chunk sequence included:
  - `retry: 3000`
  - initial `heartbeat`
  - periodic `heartbeat`
  - `agent.message`
  - `final`
  - continued `heartbeat` after `final`

Implications:

- the real authenticated agent route is streaming through the proxy, not just the synthetic probe route
- the service is not stuck before first frame
- the connection does not automatically close on `final`; clients must treat the `final` event itself as completion
- this specific turn emitted `agent.message` and `final`, but no `agent.tool_call` or `agent.tool_result`, which is valid for a direct final response turn

### 5. The wire format now looks valid for the captured failing request

The logged chunks show normal SSE framing:

- named `event:` lines
- one `data:` line per event
- blank-line delimiters between events
- JSON payloads with escaped newlines inside the assistant text

Implication:

- the next likely failure point is the native raw-byte consumption / SSE parser layer, not the service route contract

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

### 2. Capture request-scoped SSE diagnostics from the real failing request

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

### 6. Ask iOS for raw-byte evidence instead of parsed-event evidence

The most useful mobile-side follow-up is:

- log raw byte chunks received from the stream before SSE parsing
- log the exact framing boundaries seen by the native client
- log whether the parser ignores:
  - the leading `retry:` frame
  - named `heartbeat` events
  - `final` without connection close
  - JSON payloads whose strings contain escaped `\n`

That will cleanly separate:

- “server never flushed bytes”
- from “bytes arrived but the parser never turned them into events”

## Likely Next Actions Based On Results

- Ask iOS to log raw stream bytes for the failing `/agent/stream` request before SSE parsing.
- Verify the iOS parser handles named events, blank-line delimiters, `retry:` frames, and `final` without waiting for EOF.
- If we need another backend/proxy correlation pass later, re-add targeted logging temporarily rather than assuming the removed hooks still exist.
- If raw bytes arrive on iOS but no events parse, fix the native SSE parser.
- If iOS shows no raw bytes despite Vite logging upstream chunks, investigate the downstream proxy-to-client leg more directly.
- If later retries show missed turns only after stream replacement, revisit the replay/reattach contract.

## Conclusion

The checklist correctly narrows the issue away from basic REST auth and message creation. The strongest current backend reading is:

- the route is supposed to produce heartbeat frames almost immediately
- the backend already emits only the documented agent event names
- web uses a very similar restart-after-send pattern and still works

That makes a pure “mobile is restarting the stream wrong” explanation too weak on its own. The current strongest read is:

- the real authenticated stream is producing valid SSE frames
- the proxy is receiving and forwarding those frames
- the remaining uncertainty is concentrated in the native client’s raw-byte handling and SSE parsing path

The next debugging step should therefore move to iOS raw stream logging rather than additional generic backend transport checks.
