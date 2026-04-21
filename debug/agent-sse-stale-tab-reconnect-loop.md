# Debug: agent-sse-stale-tab-reconnect-loop

_Status: Resolved on 2026-04-21_

## Resolution

Live browser instrumentation changed the final diagnosis from the original static read.

The resolved issue was not a backend listener leak and not, in the validated repro, a pile-up of multiple leaked hook instances after HMR. The reproduced loop came from one live `useAgentStream(...)` instance whose manual stale-heartbeat reconnect logic was fighting with the browser's own native `EventSource` reconnect behavior.

The fix that resolved the issue in `web/src/features/threads/use-agent-stream.ts` was:

- dedupe manual reconnect scheduling when a reconnect timer is already pending
- clear the pending manual reconnect timer once the stream reopens
- replace, rather than stack, the heartbeat watchdog on repeated `open` events
- suppress stale-heartbeat escalation unless the underlying source is actually `OPEN`

The earlier stale-tab / idle-stream concerns remain useful product follow-up context, but they were not the direct cause of the validated noisy reconnect loop that was reproduced and fixed during this investigation.

## Environment
- Date: 2026-04-21
- Workspace: `/Users/adam/bud`
- Frontend runtime under review: Vite dev server with React 19 `StrictMode`
- Backend runtime under review: local Fastify service thread SSE routes
- Browser scenario: an already-open thread tab is revisited after hot reloads or local dev-server restarts
- Investigation method: static code review only; no live browser reproduction was run in this note

## Repro Steps
1. Start the local `service/` and `web/` dev servers.
2. Open a thread tab and leave it open.
3. While that tab remains open, trigger a few frontend hot reloads and/or restart one or both local dev servers.
4. Return to the older thread tab later.
5. Watch the browser console for repeated `[agent-sse] no heartbeat ...` and `[agent-sse] reconnecting ...` messages.
6. Send a new message in that thread and observe that the visible log spam stops once the live stream is healthy again.

## Observed
- The console sample shows repeated agent-stream heartbeat timeouts and reconnect attempts for the same `threadId`.
- The web app still functions and the loop appears to stop after a fresh user send.
- The reported console output makes it look like hundreds of reconnects may be happening per second, but the current implementation does not support that rate from a single live hook instance.
- The same symptom has not been observed as clearly on the terminal SSE path, although that may partly be because the terminal path logs less conspicuously in normal use.

## Expected
- A previously opened idle thread tab should not keep retrying a dead agent SSE connection forever after local dev restarts.
- Revisiting a stale tab should converge back to one healthy stream quickly, or stay quiet until the next active turn.
- A dead idle stream should not flood DevTools or create unnecessary background traffic.

## Static Review Scope

Reviewed specs:
- `web/src/features/threads/threads.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/lib/lib.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `web/src/src.spec.md`
- `bud.spec.md`

Reviewed implementation files in full:
- `web/src/features/threads/use-agent-stream.ts`
- `web/src/features/threads/use-terminal-session.ts`
- `web/src/features/threads/thread-stream-timing.ts`
- `web/src/features/threads/use-thread-messages.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/lib/transport.ts`
- `web/src/main.tsx`
- `service/src/routes/threads/agent.ts`
- `service/src/routes/threads/terminal.ts`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/runtime/event-bus.ts`

Referenced prior debug notes:
- `debug/agent-and-terminal-sse-request-storm.md`
- `debug/agent-sse-disconnect-investigation.md`
- `debug/sse-stream-premature-close.md`
- `debug/web-same-browser-multi-tab-thread-regression.md`

## Findings

### 1. The backend does not show an obvious agent-SSE listener or buffer leak

The server-side attach/detach path is bounded:

- `GET /api/threads/:threadId/agent/stream` attaches through `agentRuntime.attach(...)` and starts a heartbeat interval in `service/src/routes/threads/agent.ts:26-67`.
- On socket close, the route clears the heartbeat timer and calls `attachment.detach()` in `service/src/routes/threads/agent.ts:64-66`.
- `AgentRuntimeStateManager.detach()` removes the listener from the per-thread set in `service/src/runtime/agent-runtime-state.ts:274-294`.
- The replay buffer is bounded to `256` entries and `60_000` ms in `service/src/runtime/agent-runtime-state.ts:78-92`.

That means this report does not read like the March 2026 "request storm because the SSE response never really opened" bug. The current server path primes empty attaches immediately with a heartbeat in `service/src/runtime/agent-runtime-state.ts:259-268`, and it removes listeners on close. The likely problem is client-side retry behavior from stale tabs, not unbounded server retention.

### 2. The agent hook retries forever for any mounted thread view, even when the thread is idle

`useAgentStream(...)` attaches as soon as `threadId` is present in `web/src/features/threads/use-agent-stream.ts:384-413`. There is no gate around:

- `initialAgentState.active`
- current tab visibility
- whether the thread is idle vs actively streaming

Once connected, the hook watches for missed heartbeats and calls `scheduleReconnect('heartbeat_timeout')` in `web/src/features/threads/use-agent-stream.ts:173-185`. `scheduleReconnect(...)` always clears the current source, increments `reconnectAttemptRef`, and schedules the next attach in `web/src/features/threads/use-agent-stream.ts:153-171`.

So an old tab that still has the thread route mounted will continue trying to restore agent SSE indefinitely after local dev restarts, even when there is no active turn to observe.

### 3. The reconnect loop is real, but a single hook instance is rate-limited and much slower than it looks

The shared timing policy in `web/src/features/threads/thread-stream-timing.ts:1-16` is:

- reconnect backoff step: `500 ms`
- reconnect cap: `5000 ms`
- dev heartbeat timeout: `3000 ms`
- dev heartbeat check interval: `1000 ms`

From that implementation, one hook instance can only do all of the following:

- log one stale-heartbeat warning per open connection
- schedule one reconnect timer per failure cycle
- settle into at most one reconnect roughly every `5 s` after backoff caps out

That implies a single stale tab tops out around:

- `12` new `/agent/stream` requests per minute
- `24` warning lines per minute once the loop is steady

It does not imply "hundreds per second" from one live hook. The sample attempt number around `4890` is more consistent with a stale tab that has been looping for hours than with a same-moment burst. Rough order of magnitude:

- `4890 * 5 s ≈ 24,450 s`
- `24,450 s ≈ 6.8 hours`

So the visible console tail is best read as a long-lived bounded retry loop, not an instantaneous runaway loop from one stream.

### 4. The code explains why sending a new message makes the noise stop

When the user submits a new message, `ThreadView.handleSubmit(...)` does two important things in `web/src/routes/$budId/$threadId.tsx:277-283`:

1. refreshes `/agent/state`
2. calls `ensureAgentStreamConnected()`

`ensureAgentStreamConnected()` in `web/src/features/threads/use-agent-stream.ts:424-440`:

- clears any pending reconnect timer
- resets the reconnect attempt counter
- opens a fresh stream immediately if the current source is closed

That matches the observed "spam stops once we send a new message" behavior. The active route resets itself back to one healthy live connection when a new turn begins.

### 5. This looks dev-biased because the app runs in `StrictMode` and the thresholds are aggressive in development

The web app is mounted under `React.StrictMode` in `web/src/main.tsx:19-23`. StrictMode by itself is not enough to explain the whole symptom, but it does make development lifecycle edge cases more visible.

More importantly, the dev heartbeat thresholds are intentionally aggressive:

- only `3 s` without an event is considered stale
- checks run every `1 s`

That is reasonable for catching broken dev streams quickly, but it also makes stale old tabs very noisy after:

- Vite HMR
- manual service restarts
- local network blips
- background-tab suspension/resume

Production uses `15 s` / `5 s` instead, so the same loop is materially less noisy outside local dev.

### 6. The terminal path is not clearly immune, but it is better insulated and less alarming in logs

The terminal hook shares the same timing helpers in `web/src/features/threads/use-terminal-session.ts:853-861`, so heartbeat-based reconnects can also happen there.

However, there are a few differences:

- terminal cleanup explicitly removes each event listener before closing the source in `web/src/features/threads/use-terminal-session.ts:823-838`
- terminal reconnect logs are spread across a broader recovery path instead of a single `[agent-sse]` prefix
- terminal recovery only keeps polling when the SSE transport is still open but the Bud is offline in `web/src/features/threads/use-terminal-session.ts:899-934`

So the terminal code may still reconnect quietly under similar circumstances, but the agent stream is the more obvious noisy case because it stays mounted all the time and logs every stale reconnect under one prefix.

### 7. The current auth-check helper is not the main amplifier for the reported heartbeat-timeout loop

`createAuthEventSource.checkUnauthorized()` only probes `/api/me` after the source is already `CLOSED` in `web/src/lib/transport.ts:114-138`.

In the reported sample, the primary reason is `heartbeat_timeout`, not repeated `connection_error`. That means the main loop is:

- open stream
- miss heartbeats
- custom reconnect

not:

- immediate close
- auth probe
- reconnect

So this issue is not primarily another `/api/me` storm.

## Hypotheses

### 1. Strongest: the active thread tab is stuck in a bounded idle reconnect loop after dev restarts

Root mechanism:

- the thread route keeps `useAgentStream(...)` mounted even when idle
- the old stream stops receiving heartbeats after HMR or service restart
- the dev heartbeat policy marks it stale after `3 s`
- the hook retries forever in the background until a new turn forces a fresh clean connection

Why it fits:

- matches the reported console messages exactly
- matches the "stops after send" behavior
- does not require a backend leak to explain the symptom

### 2. Strong: stale/background tabs are the real trigger, not live active work

Root mechanism:

- previously opened tabs are still mounted on old thread views
- they continue owning an EventSource and reconnect timer
- returning to the tab exposes logs from a stream that has been retrying since the dev environment changed

Why it fits:

- the report explicitly references old tabs revisited after hot reloads and dev-server restarts
- the reconnect attempt count can get very large over time without any true per-second storm

### 3. Medium: hidden-tab timer/event throttling can create false stale-heartbeat detections

Root mechanism:

- the browser may throttle background-tab timers and/or event delivery
- on resume, `lastEventTimeRef` can be old enough to trigger the `3 s` stale check immediately

Why it fits:

- this is a known pressure point for heartbeat watchdogs in hidden tabs
- the code currently has no `document.visibilityState` escape hatch

Confidence is only medium because this note did not run a browser reproduction, but it is a plausible amplifier.

### 4. Lower-confidence: HMR may leave more than one dev-only reconnect loop alive

Root mechanism:

- Fast Refresh or a stale preserved tree could leave multiple route instances alive briefly
- each instance would own its own timer and EventSource

Why it fits:

- it would explain why the console can feel much noisier than the single-hook bound above

Why it remains lower confidence:

- the static code review does not prove that multiple orphaned hook instances survive across HMR cycles here
- the current cleanup paths are broadly correct for ordinary mount/unmount

## Risk Assessment

### Browser cost

This is worth fixing, but it does not currently look like a catastrophic browser bog-down from one tab:

- one timer
- one EventSource
- bounded reconnect frequency

The most obvious local cost is DevTools/log noise. Multiple stale tabs can multiply that cost linearly.

### Server cost

The server impact looks bounded:

- extra `GET /api/threads/:threadId/agent/stream` attaches
- per-attach heartbeats
- clean detach on socket close
- bounded runtime buffer

So this is unnecessary churn, not an apparent listener-accumulation or memory-growth bug.

### Production risk

Lower than local dev, but not zero:

- production heartbeat thresholds are less aggressive
- production does not involve Vite HMR
- but idle thread views still keep agent SSE mounted and would still retry forever if the stream dies

That means the local symptom is mostly a dev ergonomics problem today, while the underlying design choice is still a product/runtime improvement opportunity.

## Most Likely Current Read

This issue is real, but the main danger is being misread.

What the code most strongly supports is:

1. an old thread tab keeps an agent SSE mounted even when the thread is idle
2. after local dev restarts or stale-tab resumption, that stream stops receiving heartbeats
3. the agent hook enters a bounded reconnect loop and keeps doing so indefinitely
4. sending a new message resets the active route back onto a healthy connection

What the code does **not** strongly support is:

- an unbounded backend listener leak
- a March-style SSE attach bug where responses close immediately because the stream was never primed
- a true hundreds-per-second reconnect loop from one live hook instance

## Proposed Fix Direction

No code changes were made in this note. The best next fix direction is on the browser side.

### 1. Stop treating idle threads like permanently live SSE subscriptions

The cleanest fix would be to keep agent SSE attached only when it is useful:

- while an agent turn is active
- during a short post-send or post-resync window
- optionally while the thread view is focused/visible

Idle thread tabs can always refresh from `/agent/state` before the next turn starts.

### 2. Pause reconnects while the tab is hidden

Add a visibility gate around agent reconnect scheduling:

- if `document.visibilityState === 'hidden'`, do not keep retrying every few seconds
- reconnect once on `visibilitychange` or focus

That directly targets the stale-tab/dev-restart case the report describes.

### 3. Relax or specialize the dev stale-heartbeat policy

The current `3 s` threshold is intentionally aggressive, but it is brittle around dev restarts. Options:

- longer dev timeout for idle streams
- separate policy for hidden tabs
- suppress repeated stale-heartbeat warnings after the first few attempts

### 4. Add targeted instrumentation before changing the contract

Useful fields for any follow-up patch:

- tab visibility state
- whether the thread was active or idle when reconnecting
- reconnect reason histogram
- time since last successful `open`

That would let us distinguish:

- one stale loop in one old tab
- vs multiple live hook instances after HMR

## Proposed Validation For A Follow-Up Patch
1. Open one thread tab, restart the local service, and confirm the tab logs at most one reconnect cycle every ~5 seconds once capped.
2. Repeat with the tab hidden, then show it again, and capture whether the first visible warning is a false stale timeout or a real dead stream.
3. Repeat with agent SSE suspended while hidden or idle and confirm the reconnect spam disappears without harming the next send.
4. Verify that `service` logs still show matched `Agent SSE listener attached` / `Agent SSE listener detached` pairs during the scenario.
