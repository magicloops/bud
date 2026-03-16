# Debug: Terminal stuck offline after Bud reconnects

## Environment

- Repo: `/Users/adam/code/bud`
- Flow under test: browser terminal view after Bud device-claim reauth and later daemon reconnect
- Browser path: `/$budId/$threadId`
- Terminal transport:
  - `POST /api/threads/:threadId/terminal`
  - `GET /api/threads/:threadId/terminal/stream`
  - `POST /api/threads/:threadId/terminal/ensure`
  - Bud `/ws` reconnect

## Repro Steps

1. Open an existing thread terminal in the web UI.
2. Put Bud through the new reauth/reconnect path.
3. Let the daemon reconnect and reattach to the existing tmux session.
4. Observe the terminal pane and console logs in the browser.

## Observed

Browser console:

```text
[terminal] Using existing session record
[terminal] SSE connected
[terminal] Bud went offline
[terminal] Bud came online
[terminal] Ignoring status event while disconnected
[terminal] Ignoring status event while disconnected
[terminal] Ignoring status event while disconnected
[terminal] SSE still connected, waiting for bud_online event (no polling)
[terminal] Bud has been offline for 30s, transitioning to offline state
```

Bud logs:

- claim completed successfully
- daemon reconnected over `/ws`
- service sent `terminal_ensure`
- daemon reattached to the existing tmux session
- output watcher resumed and emitted `terminal_output`

This means the daemon-side reconnect appears healthy, but the browser stays in an offline/reconnecting state and does not resume terminal UX correctly.

## Expected

- after the Bud reconnects, the browser terminal should recover automatically
- the UI should leave `reconnecting` / `bud_offline`
- terminal status should resolve back to `creating`, `ready`, or `active`
- terminal history and new output should continue rendering without requiring a manual refresh

## Relevant Files Reviewed

- `web/src/routes/$budId/$threadId.tsx`
- `service/src/runtime/event-bus.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `service/src/routes/threads.ts`
- `service/src/ws/gateway.ts`

## Findings

### 1. The browser intentionally ignores terminal status while marked disconnected

In `web/src/routes/$budId/$threadId.tsx`, `handleStatus()` drops all `terminal.status` events while:

- `terminalConnectionRef.current === 'reconnecting'`, or
- `terminalConnectionRef.current === 'offline'`

That is a deliberate stale-event guard, but it means reconnect recovery now depends on some later event explicitly moving the browser back to `connected`.

### 2. The browser has no authoritative resync after reconnect

When `terminal.bud_online` arrives, the browser:

- calls `POST /api/threads/:threadId/terminal/ensure`
- if that request succeeds, sets `terminalConnection = 'connected'`

But it does not:

- fetch current terminal state from `GET /api/threads/:threadId/terminal`
- replay terminal history again
- recover any `terminal.status` events that were ignored while disconnected

So if the useful `terminal.status` events arrive before the browser flips back to `connected`, they are simply lost from the page’s point of view.

### 3. The event bus replays buffered offline/online/status events to new listeners

`service/src/runtime/event-bus.ts` replays the entire buffered event list immediately on `attach()`.

`service/src/ws/gateway.ts` and `service/src/runtime/terminal-session-manager.ts` produce a reconnect lifecycle like:

```text
bud disconnect
  -> clear old buffers
  -> emit terminal.bud_offline

bud reconnect
  -> emit terminal.bud_online
  -> browser/service trigger terminal_ensure
  -> Bud sends terminal.status("ready")
```

So a fresh or newly reconnected browser SSE listener can receive:

```text
terminal.bud_offline
terminal.bud_online
terminal.status(...)
terminal.status(...)
```

in quick succession.

### 4. The web route can issue overlapping `terminal/ensure` requests

`web/src/routes/$budId/$threadId.tsx` calls `POST /terminal/ensure` in two places:

1. immediately on SSE `open`
2. again on `terminal.bud_online`

Those two requests can race each other with the incoming status events and with the current local `terminalConnection` flag.

### 5. Once the page is stuck in `reconnecting` with SSE still open, it does not actively recover

The reconnect effect explicitly does not poll when the SSE connection is still open:

```text
SSE still connected, waiting for bud_online event (no polling)
```

That means if the page has already consumed the one useful `terminal.bud_online` event but still failed to restore state, it has no fallback path and eventually times out into `offline`.

### 6. There is a gateway ordering race worth calling out

In `service/src/ws/gateway.ts`, `handleHelloProof()` currently does:

1. update Bud row online
2. `emitBudOnlineForSessions(budId)`
3. `sendFrame("hello_ack", ...)`
4. `registerSession(budId, sessionId)`

That means the browser can receive `terminal.bud_online` and immediately call `/terminal/ensure` before the gateway has registered the Bud in the in-memory `sessions` map that backs `sendFrameToBud()`.

If that race happens, `/terminal/ensure` can still observe the Bud as offline even though the reconnect is already in progress.

The Bud logs here show successful `terminal_ensure` delivery, so this may not be the only bug, but it is a credible race in the current implementation.

## Hypotheses

### Hypothesis 1: replayed `bud_offline`/`bud_online` plus ignored status events leave the browser state machine stuck

This is the strongest current hypothesis.

Sequence:

1. browser attaches to SSE
2. buffered `terminal.bud_offline` moves UI to `reconnecting`
3. buffered or live `terminal.status` events arrive while disconnected and are ignored
4. no later authoritative state fetch occurs
5. UI remains stuck until the 30s offline timer fires

### Hypothesis 2: duplicated `terminal/ensure` calls race each other and regress terminal connection state

Because the page fires `ensure` on both SSE `open` and `terminal.bud_online`, one request can succeed while another later request still sets the UI back to `reconnecting` / `bud_offline`, depending on timing.

### Hypothesis 3: `terminal.bud_online` is emitted slightly too early in the gateway lifecycle

If `terminal.bud_online` reaches the browser before `registerSession()` finishes, the browser’s immediate `/terminal/ensure` can hit the gateway before `sendFrameToBud()` is able to route frames to the newly reconnected Bud.

### Hypothesis 4: the browser needs a post-reconnect state resync, not just event-driven optimism

Even if event ordering is mostly correct, the page is too dependent on receiving one perfect sequence of SSE events. A single missed/ignored status event can strand it.

## Proposed Fix

Minimal patch outline:

1. Make reconnect recovery idempotent in the web terminal state machine.
2. After successful `terminal/ensure` on reconnect, fetch authoritative terminal state and/or history instead of relying only on later `terminal.status` events.
3. Reduce or serialize duplicate `terminal/ensure` calls during reconnect.
4. Consider moving `registerSession()` earlier than `emitBudOnlineForSessions()` in the gateway so `bud_online` is emitted only after the Bud is routable through `sendFrameToBud()`.
5. Revisit whether replayed `terminal.status` events should always be ignored while disconnected, or whether some reconnect-time status should be allowed to restore state.

## Spec Files Affected If We Fix This

- `web/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/ws/ws.spec.md`

