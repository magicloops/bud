# Debug: xterm.js stops updating after service restart (dev mode)

## Environment
- OS / arch / versions: macOS, Bud daemon (tmux-backed terminal), backend service (Node/Fastify, tsx watch), web UI (Vite dev).
- Scenario: Hot-reload of backend service via file edit (tsx watch restarts process).

## Repro steps
1. Start backend service, web frontend, and Bud daemon.
2. Open web UI; terminal loads, accepts input, displays output correctly.
3. Edit a backend file (e.g., `terminal-manager.ts`) to trigger service restart via tsx watch.
4. Wait for service to restart (Bud daemon reconnects automatically).
5. Type in the terminal UI.

## Observed
- Keystrokes **are sent** to the backend (input POST succeeds, Bud daemon receives and executes via tmux).
- Commands **execute correctly** server-side (visible in tmux if attached directly).
- The frontend SSE stream **receives output events** (visible in network tab / logs).
- However, **xterm.js does not update** — the terminal view is frozen/static.
- A full page refresh fixes the issue.

## Expected
- After service restart, the terminal should continue updating with new output.

---

## Architecture Overview

### Data Flow (healthy state)

```
User types in xterm.js
       ↓
term.onData callback fires (App.tsx:192-197)
       ↓
sendTerminalInput() → POST /api/terminals/:budId/input
       ↓
TerminalManager.sendInput() → sendFrameToBud() via WebSocket
       ↓
Bud daemon receives terminal_input → tmux send-keys
       ↓
Bud daemon reads tmux output → emits terminal_output frame via WebSocket
       ↓
gateway.ts:handleTerminalOutput() → terminalManager.handleTerminalOutput()
       ↓
TerminalManager stores to DB + events.emit("terminal.output", {...})
       ↓
TerminalEventBus notifies attached SSE listeners
       ↓
/api/terminals/:budId/stream SSE endpoint → EventSource in browser
       ↓
handleOutput callback (App.tsx:367-389) → terminalRef.current.write(decoded)
       ↓
xterm.js renders the output
```

### Key Components

#### Frontend (App.tsx)

1. **Terminal Instance** (lines 164-206):
   - `terminalRef` holds the xterm.js Terminal instance
   - Created once when `terminalPaneRef.current` is available and `terminalRef.current` is null
   - `term.onData()` callback sends input via `sendTerminalInputRef.current()`

2. **SSE Stream Setup** (lines 341-436):
   - Opens `EventSource` to `/api/terminals/${budId}/stream`
   - Has reconnect logic with backoff on error
   - `handleOutput` parses JSON and writes to `terminalRef.current`
   - Effect depends on `[budId, fitTerminal, resetTerminal]`

3. **Terminal Reset** (lines 142-154):
   - Called when `budId` changes (in the SSE effect)
   - Calls `term.reset()` which clears the terminal
   - Sets `terminalHasOutput` to false

#### Backend

1. **TerminalEventBus** (event-bus.ts):
   - `emit(channelId, event)` pushes to buffer and notifies listeners
   - `attach(channelId, reply)` adds SSE listener, replays buffer
   - Listeners stored in `Map<string, Set<Listener>>`

2. **SSE Endpoint** (server.ts:97-101):
   ```typescript
   server.get("/api/terminals/:budId/stream", (request, reply) => {
     const budId = (request.params as { budId: string }).budId;
     const detach = terminalEvents.attach(budId, reply);
     reply.raw.on("close", detach);
   });
   ```

3. **TerminalManager** (terminal-manager.ts):
   - `handleTerminalOutput()` stores output to DB and emits via `events.emit()`
   - Instance created in `buildServer()` with a `TerminalEventBus` instance

---

## Hypotheses

### 1. **TerminalEventBus instance is recreated on service restart, but SSE connections hold stale reference**

When the service restarts:
- A **new** `TerminalEventBus` instance is created in `buildServer()` (server.ts:43)
- The **old** EventSource connection in the browser **may still be connected** to the old process (HTTP keep-alive, or reconnect to new process)
- However, the SSE listener registered with `terminalEvents.attach()` was attached to the **old** event bus instance
- When output events are emitted on the **new** event bus, there are **no listeners** because the browser's EventSource reconnected but the reply object is from a fresh request

**Why this could happen**: The frontend's EventSource has reconnect logic, but after reconnect it's talking to the new server instance. The `reply.raw.on("close", detach)` should have fired when the old connection closed, but the new connection's `attach()` happens on the new event bus.

**Expected behavior**: This should actually work because reconnect opens a new HTTP request → new `attach()` on new event bus.

**Counter-evidence**: User says SSE stream receives output events — this would mean the new listener IS attached. So this hypothesis is likely wrong unless the "receives events" observation is incorrect.

### 2. **terminalRef becomes stale/null after service restart triggers React re-render**

The SSE `handleOutput` callback (lines 367-389) reads from `terminalRef.current`:
```typescript
if (decoded && terminalRef.current) {
  terminalRef.current.write(decoded)
```

If something causes `terminalRef.current` to become `null` or point to a disposed Terminal instance:
- Output events arrive but `terminalRef.current` is falsy
- The conditional skips the write
- Log shows: `console.warn('[terminal] output skipped; terminalRef missing')` (line 383)

**Possible triggers**:
- The SSE effect (lines 341-436) depends on `[budId, fitTerminal, resetTerminal]`
- If any of these change after service restart, the effect re-runs
- The effect calls `resetTerminal()` on line 354 which does `term.reset()` but doesn't dispose
- However, the terminal **creation** effect (lines 156-207) only runs if `!terminalRef.current`

**Why this could happen**: If the SSE effect re-runs (due to dependency change) but the terminal creation effect doesn't, the handlers could have a stale closure over an old `terminalRef`.

### 3. **Closure captures stale terminalRef due to effect dependency timing**

The `handleOutput` function is defined **inside** the SSE effect:
```typescript
const handleOutput = (event: MessageEvent) => {
  // ...
  if (decoded && terminalRef.current) {
    terminalRef.current.write(decoded)
  }
}
```

This function closes over `terminalRef`. However, `terminalRef` is a `useRef` so `terminalRef.current` should always be the latest value since refs are mutable.

**BUT**: If the Terminal instance is disposed and recreated, `terminalRef.current` would point to a new Terminal, and the closure would still access the ref correctly.

**Why this is likely not the issue**: Refs don't suffer from stale closure problems since we access `.current` at call time.

### 4. **EventSource reconnect creates new listeners but old connection isn't fully closed**

The SSE effect cleanup function (lines 432-435):
```typescript
return () => {
  cleanupTimers()
  closeSource()
}
```

This should close the EventSource when the effect re-runs. But what if:
- The service restart causes the EventSource to error
- The reconnect logic (`scheduleReconnect`) fires before the effect cleanup
- Multiple EventSource connections exist, with events going to a "ghost" listener

**Evidence needed**: Check if multiple EventSource connections exist in network tab after restart.

### 5. **`resetTerminal()` clears xterm but SSE reconnect replays buffered events too early**

The sequence after SSE reconnect:
1. Effect runs → `resetTerminal()` called → `term.reset()` clears terminal
2. EventSource opens → `terminalEvents.attach()` replays buffer
3. Buffer events arrive before xterm is ready to display them

The TerminalEventBus replays buffered events immediately in `attach()`:
```typescript
for (const event of buffer) {
  listener(event);
}
```

If `resetTerminal()` runs AFTER the buffered events are replayed, the terminal is cleared and appears frozen.

**Actually**: Looking at the code, `resetTerminal()` is called BEFORE `connect()` is called (line 354 before 430), so this shouldn't be an issue.

---

## New Finding: Bud Daemon Output Watcher

After examining the Bud daemon code (`bud/src/main.rs`), the terminal output flow is:

1. `TerminalManager::spawn_output_watcher()` (lines 1125-1173) spawns a tokio task that:
   - Polls the tmux log file every 50ms
   - When new data appears, sends `terminal_output` frame via WebSocket

2. When the service restarts, the Bud's WebSocket connection closes, triggering `clear_sender()` (lines 783-789):
   ```rust
   async fn clear_sender(&self) {
       let mut inner = self.inner.lock().await;
       if let Some(handle) = inner.handle.take() {
           handle.watcher.abort();  // <-- WATCHER IS ABORTED
       }
       inner.sender = None;
   }
   ```

3. After reconnect, `run_session()` calls:
   - `set_sender(sender.clone())` — sets the new sender
   - `handle_ensure(None)` — should recreate the terminal handle + watcher

4. `handle_ensure()` checks `if inner.handle.is_some()` — after `clear_sender()` the handle is gone, so it should call `ensure_tmux_session()` which spawns a new watcher.

**Potential issues:**
- The new watcher might fail to start (check Bud logs for errors)
- The tmux session might not exist anymore
- The log file offset tracking might be wrong

---

## Most Likely Hypothesis: #2 or Related

Given that:
- Input works (POSTs succeed)
- SSE appears to receive events
- xterm doesn't update

The issue is likely in the **write path from SSE handler to xterm**:

1. `terminalRef.current` is null or stale when `handleOutput` fires
2. The decoded data is empty (though logs say otherwise)
3. The Terminal instance is disposed but ref not cleared

**Key debugging step**: Check if `console.warn('[terminal] output skipped; terminalRef missing')` appears in console after service restart.

---

## Proposed Investigation Steps

1. Add logging at the start of `handleOutput`:
   ```typescript
   console.info('[terminal] handleOutput', {
     hasTerminalRef: !!terminalRef.current,
     readyState: source.readyState
   })
   ```

2. Log in the terminal creation effect when terminal is created/disposed

3. Check React DevTools for unexpected re-renders of App component

4. Verify EventSource reconnection sequence in network tab:
   - Old connection closes cleanly?
   - New connection opens?
   - Events flowing on new connection?

5. Add a manual "reconnect terminal" button to test SSE re-subscription without page refresh
