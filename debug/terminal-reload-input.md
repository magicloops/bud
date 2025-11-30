# Debug: Terminal input breaks after page reload

## Environment
- OS / arch / versions: Bud daemon on macOS (tmux-backed terminal), backend service (Node/TS), web UI (Vite).
- DB: Local Postgres/Supabase (dev); connection string not inspected.
- LLM mode: Not relevant (manual UI use).

## Repro steps
1. Start backend and Bud (terminal enabled; tmux available).
2. Open web UI; terminal loads and accepts input; commands flow to tmux successfully.
3. Refresh the page (same tab).
4. Terminal appears but keystrokes in xterm.js no longer send; no visible errors in browser console, service logs, or Bud daemon output.

## Observed
- First load works: input reaches tmux and output streams back.
- After reload: xterm visible but typing has no effect; no console/service/Bud errors.
- Unclear whether input handler fires, SSE/REST fetches return, or focus/resizing resets the terminal state.
- With UI logging: history fetch returns 200; status event shows `ready`; onData fires and `send input` logs with budId/bytes, so keystrokes are dispatched via `/api/terminals/:budId/input`. No corresponding output/status change is seen after sending input.
- After backend restart + Bud reconnect: Bud logs show terminal_input handled and tmux send-keys succeeding, but the web UI terminal does not render the typed characters or subsequent output. Service logs show normal terminal routes; interop appears fine, rendering/stream consumption in UI may be broken.
- Latest: Network tab shows terminal input POSTs succeeding (`{ok:true}`) and onData logs fire, but no `[terminal] output event` logs appear; after a page refresh, prior commands show up (history fetch works). Suggests the SSE stream is dead/stale and not reconnecting after backend restart.
- Even after a page refresh, the terminal UI often stays blank (no live output), though commands still send; output only appears on a subsequent refresh via history. Strongly indicates the terminal SSE stream isn’t attaching or is closing immediately.
- Current expected flow (when healthy): UI onData → POST `/api/terminals/:budId/input` → terminal_manager.sendInput → ws_gateway → Bud tmux send-keys → Bud emits `terminal_output` → gateway → terminal_manager.handleTerminalOutput → terminalEvents.emit → `/api/terminals/:budId/stream` EventSource → UI writes to xterm. Logs show success up through Bud tmux send-keys; breakage is between gateway/terminal_manager output handling and UI EventSource consumption.
- Current code paths (key files):
  - UI: `web/src/App.tsx` mounts xterm; on bud change calls ensure + history, opens EventSource to `/api/terminals/:budId/stream` with reconnect/backoff; handlers parse JSON and write to xterm.
  - Backend SSE: `/api/terminals/:budId/stream` in `service/src/server.ts` attaches to `terminalEvents` (event-bus).
  - Terminal emit: `TerminalManager.handleTerminalOutput` stores output and `events.emit` (`terminal.output`), gateway parses `terminal_output` frames.
  - Bud: handles `terminal_input` → tmux send-keys → emits `terminal_output` frames (base64) watched from log file.

## Expected
- After reload, terminal should reattach to the existing tmux session and accept input normally.

## Hypotheses
1. **SSE stream still not attaching/retrying**: EventSource may fail to open (proxy/CORS) or reconnect after backend restart, leaving no output events despite inputs succeeding; need network confirmation of opens/errors.
2. **Gateway → terminal_manager output path failing silently**: `terminal_output` frames may not be parsed/forwarded (terminalEnabled gating, parse rejection, missing sender) so SSE emits nothing even though Bud sends and DB history captures later.
3. **TerminalEventBus/SSE delivery blocked**: listeners for `budId` may not be attached or reply.sse may not flush after restart, so emitted events never reach the client.
4. **UI output handler not firing / data empty**: Even if SSE delivers, handler might skip due to parse/data shape or terminalRef being null during event; need raw event logging.
5. **Race between resetTerminal and early output**: reset clears xterm; if EventSource connects late or initial output arrives before terminalRef is ready, those writes are lost, leaving the pane blank until a later history backfill.

## Proposed fix
- Instrument UI terminal lifecycle (ensure/status/history/stream, input handler attach, focus/resize) with debug logs; verify the ensure call and stream subscription after reload.
- Confirm focus and fit are invoked once the xterm container mounts; force focus after mount.
- Add visible error/toast when REST/SSE calls fail on reload to surface hidden 4xx/5xx.

## Next actions
- [x] Add SSE reconnect logic (backoff) and log EventSource open/error to confirm closures (implemented in UI).
- [ ] Capture network panel for `/api/terminals/:budId/stream` after restart/reload to see if the stream opens and events flow (check open/error/retry).
- [x] Add backend logging around terminal_output handling/gateway dispatch to confirm output is emitted after Bud reconnects (implemented).
- [ ] Confirm UI state: ensure terminalRef is non-null when output events should fire; log raw SSE data and readyState on error/close.
- [ ] Consider buffering/resending last output chunk server-side for new SSE subscribers to avoid losing early output after reset.
