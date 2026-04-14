# Debug: Browser terminal input leaks xterm protocol bytes

## Environment
- macOS local development with `service`, `web`, and `bud` running against the same thread-scoped tmux session.
- Browser terminal rendered with xterm.js in Chrome through the Vite frontend.
- Thread route: [`web/src/routes/$budId/$threadId.tsx`](../web/src/routes/$budId/$threadId.tsx).

## Repro Steps
1. Open an existing Bud thread in the browser and wait for the shared terminal to connect.
2. Focus the xterm pane, interact with a shell or TUI, then trigger terminal-emulator behaviors such as refocus, paste, or programs that query terminal capabilities.
3. Observe the bytes that reach the tmux session through the browser terminal input path.

## Observed
- The browser currently treats xterm's `onData(...)` stream as the authoritative source of outbound terminal input.
- That `onData(...)` stream can include emulator-generated protocol replies in addition to genuine human keypress intent.
- The frontend batches the raw string and POSTs it to `/api/threads/:threadId/terminal/input`.
- The service forwards the payload as opaque UTF-8 bytes through `terminal_input`.
- Bud decodes those bytes and injects them into tmux with `send-keys -l`, splitting only trailing newlines into `Enter` keys.
- As a result, xterm-originated control traffic can leak into the shared tmux session as if the human typed it.

## Expected
- The browser escape hatch should submit only explicit human intent.
- Supported keyboard actions and paste text should still reach the same tmux session the agent uses.
- Emulator-generated replies should never be forwarded as typed user input.

## Hypotheses
1. The bug boundary is the browser, not the service or Bud transport. Provenance still exists at the DOM/xterm event layer and is lost once `onData(...)` is forwarded.
2. Reusing the current `/terminal/input` endpoint is acceptable for phase 1 as long as the browser submits only explicit supported human intent.
3. A small pure translation layer for keyboard and paste events is enough to support the escape-hatch workflows we care about now.
4. `Ctrl+C` should use raw terminal bytes through the normal input path so shells, pagers, REPLs, and TUIs all keep their expected semantics.

## Proposed Fix
- Remove outbound dependence on xterm `onData(...)` in the thread route.
- Add a pure browser terminal-input translator under `web/src/lib/` for:
  - printable text
  - `Enter`, `Tab`, `Backspace`, `Escape`
  - arrows, `Home`, `End`, `PageUp`, `PageDown`
  - raw `Ctrl+A` through `Ctrl+Z`
- Preserve explicit browser copy/paste behavior:
  - copy remains browser-native when the user is clearly copying selected text
  - paste uses an explicit clipboard handler instead of terminal key translation
- Send raw `Ctrl+C` through `/terminal/input` rather than the dedicated interrupt endpoint.
- Add dev-only logging for unsupported modifier combos and composition events so omitted phase-1 support is visible instead of silent.

## Spec Files Affected
- [`../web/src/lib/lib.spec.md`](../web/src/lib/lib.spec.md)
- [`../web/src/routes/$budId/budId.spec.md`](../web/src/routes/$budId/budId.spec.md)
- [`../web/src/routes/routes.spec.md`](../web/src/routes/routes.spec.md)
- [`../web/web.spec.md`](../web/web.spec.md)
- [`../bud.spec.md`](../bud.spec.md)
