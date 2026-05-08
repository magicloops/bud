# Mobile Terminal Input Contract Handoff

**Date:** 2026-04-29
**Audience:** Mobile clients using Bud thread terminal endpoints
**Status:** Web fix shipped in `ea6de63` (`Browser Terminal Input Contract (#20)`)

## Summary

The terminal input route is a low-latency human input escape hatch, not a full terminal-emulator stdin transport.

Mobile must not forward terminal-emulator generated response bytes to:

```text
POST /api/threads/:threadId/terminal/input
```

Only explicit human intent should go to that route: typed text, supported control/navigation keys, and explicit paste text. Terminal replies such as device-attributes responses, OSC color-query responses, focus reports, mouse reports, screen-size responses, and binary callbacks must be ignored for this route.

## What Broke On Web

The old web pipeline was:

```text
xterm.onData -> browser buffer -> POST /terminal/input -> terminal_input -> tmux send-keys
```

That treated every outbound xterm byte as user input. That assumption was wrong. xterm can emit protocol responses on its own, including DA, OSC color, and focus responses. Once those bytes reached the service as a plain JSON `input` string, the service and Bud daemon had no provenance left and injected them into tmux as if the user typed them.

The root cause was not UTF-8. The bug was loss of framing and provenance at the client boundary.

## Web Fix Shipped

The web client fix was client-side:

- removed outbound dependence on `xterm.onData(...)`
- did not add an `onBinary(...)` forwarding path
- added `web/src/lib/terminal-input.ts` as a pure translator for supported human keyboard/paste intents
- uses `term.attachCustomKeyEventHandler(...)` to inspect keydown events before xterm handles them
- adds an explicit paste listener on the xterm textarea/container
- batches supported input for 20 ms before posting to `/terminal/input`
- flushes raw `Ctrl+C` immediately as `\x03`
- keeps resize on `/terminal/resize`
- keeps output rendering on `/terminal/stream` only
- logs unsupported key/composition cases in development

The current implementation lives in:

- `web/src/lib/terminal-input.ts`
- `web/src/features/threads/use-terminal-session.ts`

## API Contract

### Input

```http
POST /api/threads/:threadId/terminal/input
Content-Type: application/json
Authorization: Bearer <token> or cookie session
```

```json
{
  "input": "ls -la\n"
}
```

Server behavior:

- requires authenticated access to the owned thread
- validates `{ input: string }` with at least one character
- resolves the active terminal session for the thread
- encodes `input` as UTF-8 bytes
- forwards those exact bytes as human-originated terminal input
- returns `{ "ok": true }` on dispatch

Important: the server does not and cannot distinguish user keystrokes from emulator protocol bytes once the client sends this JSON payload. The client must enforce provenance before calling the route.

### Resize

Terminal size belongs on:

```text
POST /api/threads/:threadId/terminal/resize
```

Body:

```json
{
  "cols": 120,
  "rows": 32
}
```

Do not encode screen-size changes or terminal-size reports into `/terminal/input`.

### Output

Terminal output is received from:

```text
GET /api/threads/:threadId/terminal/stream
```

`terminal.output` events contain base64 terminal bytes. Decode and render them into the terminal view. Never feed rendered output or terminal-emulator responses back into `/terminal/input`.

## Required Mobile Behavior

Mobile should treat the terminal view as an explicit human-intent input surface.

Do:

- capture text insertion from native keyboard APIs as user text
- capture hardware-key commands directly where available
- capture paste through an explicit paste path
- translate supported key actions into known terminal byte sequences
- send only those translated strings to `/terminal/input`
- gate sends on active terminal view plus connected terminal state
- batch normal input briefly, similar to web's 20 ms buffer
- flush `Ctrl+C` immediately as `\x03`

Do not:

- wire an emulator `onData`, `onInput`, `onSend`, `onBinary`, or equivalent transport callback directly to `/terminal/input`
- forward terminal-emulator generated replies
- forward OSC/DA/focus/color/mouse/screen-size protocol responses
- forward binary terminal data to the JSON input route
- infer user intent from bytes after they leave the emulator
- send terminal resize through `/terminal/input`

## Supported Phase-1 Input Set

Use this same mapping as web unless mobile has an explicit reason to narrow support:

| User action | Input string |
|-------------|--------------|
| Printable text | literal text |
| Enter | `\n` |
| Tab | `\t` |
| Backspace | `\x7f` |
| Escape | `\x1b` |
| Arrow up | `\x1b[A` |
| Arrow down | `\x1b[B` |
| Arrow right | `\x1b[C` |
| Arrow left | `\x1b[D` |
| Home | `\x1b[H` |
| End | `\x1b[F` |
| Page up | `\x1b[5~` |
| Page down | `\x1b[6~` |
| Ctrl+A through Ctrl+Z | ASCII control byte (`A` -> `\x01`, `C` -> `\x03`) |
| Paste | plain text, including multiline text |

For `Ctrl+C`, send `\x03` through `/terminal/input`. Do not use `/terminal/interrupt` for normal terminal keyboard input. The interrupt route still exists for backend/browser control flows, but the web terminal escape hatch uses raw ETX so shells, pagers, REPLs, and TUIs receive normal terminal semantics.

## Known Limitations

The current escape hatch intentionally does not support:

- emulator-originated DA / DEC private mode replies
- OSC 10 / 11 / 12 color-query replies
- focus-in / focus-out replies
- mouse reporting
- terminal binary input streams
- Alt / Meta terminal forwarding
- IME/composition input

If mobile needs full terminal fidelity, the right next design is a separate PTY-backed browser/native attach path:

```text
PTY output -> terminal renderer
terminal onData -> stdin-text frame -> PTY stdin
terminal onBinary -> stdin-binary frame -> PTY stdin
resize -> resize frame -> PTY resize
```

That should not be implemented by stretching `/terminal/input`.

## Suggested Mobile Implementation Shape

Keep the same separation web now uses:

```text
terminal output stream -> terminal renderer
native keyboard/paste intent -> translator -> small input buffer -> POST /terminal/input
terminal size changes -> POST /terminal/resize
```

Language-neutral sketch:

```text
onHumanText(text):
  enqueueTerminalInput(text)

onHumanKey(key, modifiers):
  intent = translateSupportedTerminalKey(key, modifiers, hasSelection)
  if intent is browserShortcut:
    let platform handle it
  if intent is unsupported:
    log in development only
  if intent is input:
    enqueueTerminalInput(intent.text, flushImmediately: intent.text == "\x03")

onPaste(text):
  if text is not empty:
    enqueueTerminalInput(text)

enqueueTerminalInput(text, flushImmediately):
  require terminalViewActive
  require terminalConnection == connected
  append text to buffer
  flush after 20 ms, or immediately for Ctrl+C
```

## Validation Checklist

Before considering mobile fixed, verify:

- focusing/refocusing the terminal does not inject visible protocol fragments
- repeated focus/refocus does not inject DA, color, or focus-report tails
- a TUI that queries colors does not cause `10;rgb:...` text to appear in the shell/TUI
- printable typing works
- Enter, Tab, Backspace, arrows, Home, and End work
- single-line and multiline paste work
- selected terminal text can still be copied without sending `Ctrl+C` as ETX
- `Ctrl+C` interrupts a long-running command
- `Ctrl+C` interrupts a REPL/TUI where applicable
- terminal resize calls `/terminal/resize`, not `/terminal/input`
- terminal output is rendered only, not echoed back to input
- disconnected or hidden terminal views do not send input

## Source Trail

Most useful current implementation references:

- `web/src/lib/terminal-input.ts`: supported input translation, copy/paste precedence, unsupported logging
- `web/src/features/threads/use-terminal-session.ts`: xterm lifecycle, key/paste listener hookup, 20 ms input batching, resize, stream output rendering
- `service/src/routes/threads/shared.ts`: `TerminalInputBodySchema`
- `service/src/routes/threads/terminal.ts`: `/terminal/input`, `/terminal/resize`, `/terminal/stream`

Research and plan docs that led to the fix:

- `reference/xterm-deepdive.md`
- `reference/browser-terminal-input-contract.md`
- `debug/browser-terminal-input-leak.md`
- `plan/browser-terminal-input-contract/implementation-spec.md`
- `plan/browser-terminal-input-contract/validation-checklist.md`

The fixing commit was:

```text
ea6de63 Browser Terminal Input Contract (#20)
```
