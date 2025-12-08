# Debug: Interactive session input blocked

## Environment
- macOS (local dev), pnpm + Vite frontend, Node backend, Rust Bud agent.
- Service + Bud built from current `adam/interactive-sessions` branch.
- Browser: local Vite dev server (http://localhost:5173) proxying to `service` (`VITE_API_PROXY_TARGET=http://localhost:3000`).

## Repro steps
1. `pnpm dev` in `service/`, `pnpm dev` in `web/`, and `cargo run -- --server ws://localhost:3000/ws --token DEV-LOCAL-ONLY` for Bud.
2. Load the workbench, pick a Bud/thread, and click **Start session** in the “Interactive session (beta)” pane.
3. Wait for “Session open — start typing to send commands.” Overlay disappears, remote shell prompt (`MacBook-Pro…$`) is visible.
4. Attempt to type characters; nothing is echoed or sent downstream.

## Observed
- UI reports the session as open; xterm displays backend output (login shell banner) correctly.
- Keyboard input produces no console errors, no messages in the service logs, and no `input` frames visible client-side.
- Hot module reload occasionally makes typing work, but a full refresh consistently reproduces the dead input.
- With frontend logging enabled we now see:
  - `[session] status payload … role: "writer"` confirming the server hands us the writer lease.
  - `[session] onData { len: 1 }` and `[session] input { len: 1, role: "writer", status: "open", socketReady: 1 }` proving xterm emits bytes and the browser sends them over an open socket.
  - No `[session] blocked input` warnings, so the guards aren’t firing.

## Expected
- Once the session is open and writer-attached, typing should immediately send `session_input` frames via `/term` WS and echo in the PTY.

## Hypotheses
1. **Role gating never flips to writer:** The frontend guard only emits input when `interactiveSession.role === 'writer'`. We optimistically set `role: 'writer'` on creation, but the backend `status` frames may omit `role` or default to `spectator`, downgrading the state before the first keystroke. We should log incoming `status` payloads and ensure the server returns `role:"writer"` for the initial writer token, or auto-call `/take-writer` after session creation.
2. **WebSocket reference remains `null`:** `sendInteractiveInput` requires `interactiveSession.socket` to exist. Even though we stash the socket in state, the callback captures the previous `interactiveSession` value, so keystrokes may still see `socket === null`. We should drive sending from `termSocketRef.current` or update the ref directly inside the WS effect.
3. **xterm focus + hidden textarea:** The terminal only forwards `onData` when its hidden `<textarea>` has focus. Our focus effect fires before the writer status flips to `open`, so the `canType` check blurs the terminal again. We may need to focus unconditionally after `term.open()` and when `interactiveStatus === 'open'`.
4. **Role resets to spectator:** Backend `status` frames might omit `role`, causing `prev.role` to survive as `'spectator'`. Our guard blocks sending when not writer, so even with a socket the input is discarded. Confirm by logging payloads or inspecting session_manager logs to see if multiple sockets compete for writer.
5. **Protocol mismatch / server rejection (confirmed):** Browser sends `{type:"input", data:base64}` text frames, but the Fastify `/term` gateway was returning early because `ws` delivers inputs as `Buffer` objects. We now decode `RawData` (Buffer/ArrayBuffer/etc.) before parsing so `sessionManager.sendInput` actually fires. Need to retest with the new handler.
6. **onData not firing:** (ruled out) Logging shows `onData` fires, so this isn’t the culprit.
7. **State cleared on bud change / thread change:** Effects teardown remains a possibility but less likely since ws logs stay active throughout typing.
8. **Bud decoding bug:** Bud may not decode the base64 data or may require newline buffering before echoing; inspecting `bud/src/main.rs` `session_input` handler or adding logs there can confirm.

## Proposed fix
- Add temporary instrumentation (console logs for `payload.role`, `interactiveSession.role`, `sendInteractiveInput` executions, and `termSocketRef.current`) to confirm whether guards fire and sockets exist.
- Mirror logging server-side: in `service/src/ws/term-gateway.ts` log the parsed `input` payloads and results of `sessionManager.sendInput`; in Bud log `session_input` frames and writes to the PTY.
- Store the socket in a ref (or always read from `termSocketRef.current`) so input sending doesn’t depend on React state propagation.
- Force-focus xterm when the session opens regardless of writer status; consider removing the blur logic entirely until we have explicit spectator controls.
- Verify `/term` server accepts the JSON payload by sending a manual `ws.send` from DevTools; if it fails, align schema / use binary frames.
- If logging shows the role remains `spectator`, adjust backend `SessionManager` to hand the writer lease to the first attach or have the UI auto-call `/take-writer`.
- Inspect Bud’s `session_input` handler to ensure it decodes `data` and writes to the PTY; add logs if missing.

## Next actions
- [ ] Confirm whether `interactiveSession.role` flips to `writer` via logging.
- [ ] Verify `sendInteractiveInput` actually runs when pressing keys (log inside the callback).
- [ ] Switch `sendInteractiveInput` to always use `termSocketRef.current`.
- [ ] Force xterm focus once the session open event fires and ensure overlays are not intercepting pointer events.
- [ ] Loop in backend owners to confirm the expected `/term` input schema if client instrumentation looks correct; add logs in `sessionManager.sendInput`.
- [ ] Audit Bud’s `session_input` decoding/writing path.
