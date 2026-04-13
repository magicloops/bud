# Debug: thread-terminal-codex-tui-osc-color-reply-leak

## Environment
- Web thread terminal view using xterm.js
- Service `/api/threads/:threadId/terminal/*` browser terminal routes
- Bud daemon with tmux-backed thread-scoped terminal sessions
- Reproduced while starting the Codex TUI inside the thread terminal

## Repro Steps
1. Open a thread page with an attached terminal session.
2. Start the Codex TUI in the terminal.
3. Watch the TUI input area during startup.

## Observed
- The following printable text appears in the Codex TUI input area during startup:

```text
10;rgb:d1d1/ffff/e1e111;rgb:0000/0000/0000
```

- The visible payload strongly resembles two concatenated terminal color-query replies:
  - `OSC 10` foreground color
  - `OSC 11` background color
- The likely original terminal-emulator reply shape is closer to:
  - `ESC ] 10;rgb:... BEL`
  - `ESC ] 11;rgb:... BEL`
- The printable text we see is missing the normal OSC framing bytes, which suggests the browser xterm instance is generating a real reply but the upstream path is not preserving or delivering it as a proper terminal-response channel.
- Additional live observation:
  - refocusing the xterm view, without switching pages, tabs, or refreshing, can reproduce the same class of leak
  - observed variants include:

```text
11;rgb:0000/0000/0000
```

```text
10;rgb:d1d1/ffff/e1e111;rgb:0000/0000/000010;
```

- This strongly suggests the issue is tied to live terminal focus / capability-query behavior, not bootstrap, reconnect replay, or page lifecycle.

## Expected
- Codex TUI startup should not inject printable terminal-protocol payload into the TUI input area.
- If Codex asks the terminal for color information, the response should either:
  - reach the application as a real terminal reply that it can parse, or
  - be suppressed cleanly if the browser/tmux stack cannot faithfully support that class of terminal query.

## Current Implementation Review
- `web/src/lib/terminal-xterm-input.ts`
  - Classifies xterm `onData(...)` output as either `human` or `emulator_protocol`.
  - Uses xterm internals (`onUserInput`) when available, but still surfaces emulator-generated replies back to the app-layer transport.
- `web/src/lib/thread-terminal-controller.ts`
  - Forwards `emulator_protocol` input upstream via `transport.sendRaw(...)`.
  - Falls back to the same raw path for unsupported human/control sequences.
- `service/src/routes/threads.ts`
  - `POST /terminal/input` accepts raw browser terminal bytes and forwards them directly to the runtime manager.
- `service/src/runtime/terminal-session-manager.ts`
  - `sendInput(...)` records/logs the bytes and forwards them to Bud as `terminal_input` without protocol-specific filtering or translation.

This means the current browser terminal boundary still assumes that any xterm-generated emulator reply can be sent upstream through the same raw input path that we use for keyboard-like fallback input.

## Findings
- This symptom is different from the earlier replay-triggered `1;2c` issue, but it appears to be the same bug class:
  - xterm generates a real terminal-emulator reply
  - the browser forwards it upstream as raw pane input
  - the tmux-backed stack does not appear to deliver it back to the foreground program as a faithful terminal-protocol response
- The fact that the visible payload is specifically `10;rgb...11;rgb...` makes an OSC color-query leak much more likely than a generic rendering glitch.
- Because the issue also happens on plain xterm refocus, rich bootstrap / screen restore is not the primary cause here.
- The refocus behavior makes a live emulator-protocol path failure much more likely than any page-open or restore-path explanation.
- The current browser raw fallback surface is narrower than before, but it still includes two distinct categories:
  - `emulator_protocol` from xterm
  - unsupported human sequences that the browser parser cannot yet express structurally
- Those two categories should not be treated as equally valid reasons to use `/terminal/input`.

## Hypotheses

### 1. Codex TUI is issuing OSC 10 / 11 color queries, and xterm is replying, but our raw upstream path is not a real terminal-response channel
- Most likely.
- The browser currently forwards emulator replies via `/terminal/input`, which is fundamentally a stdin-style path into tmux.
- That may be good enough for some fallback input cases, but not for terminal query/response traffic that expects terminal-emulator semantics instead of ordinary typed input.
- This matches the earlier `1;2c` evidence that forwarding xterm replies upstream is structurally risky.

### 2. The raw browser → service → Bud → tmux path is stripping or transforming OSC framing bytes
- Also plausible.
- The printable text we see is missing the normal `ESC ]` introducers and BEL/ST terminators.
- If those framing bytes are lost during injection, the foreground program would receive only printable payload fragments like `10;rgb:...11;rgb:...` and render them into the input area.
- We have not yet verified at which hop the framing disappears.

### 3. The OSC replies are being chunked or concatenated in a way Codex cannot parse once they are re-injected through tmux
- Plausible, but lower confidence than the first two.
- The visible string looks like two replies joined together.
- If the browser or tmux path splits or replays them in an unexpected boundary pattern, the TUI may fail to recognize them as terminal replies even if some control bytes survive.

### 4. Some emulator replies should not be forwarded upstream at all unless we have explicit proof they work in the tmux-backed browser stack
- Structural hypothesis.
- We intentionally kept `/terminal/input` as a narrow raw fallback for emulator protocol and unsupported browser sequences.
- The Codex startup symptom is evidence that this remaining emulator-protocol forwarding surface is still too broad.
- The safer model may be an explicit allowlist of supported upstream emulator replies, not a blanket "all xterm-generated protocol goes upstream" rule.

### 5. `/terminal/input` is now mostly covering browser parser gaps for advanced human key sequences, not normal typing
- Important scoping finding.
- The current browser parser already handles:
  - plain printable text and paste without unsupported control bytes
  - `Enter`, `Tab`, `Backspace`, `Escape`, `Ctrl+C`
  - arrows, `Home`, `End`, `Delete`, `PageUp`, `PageDown`
- The remaining human raw-fallback cases are mostly advanced terminal/TUI sequences:
  - additional `Ctrl+<key>` chords such as `Ctrl+A`, `Ctrl+D`, `Ctrl+L`, `Ctrl+U`, `Ctrl+W`, `Ctrl+Z`
  - `Alt` / `Meta` chords
  - `Shift+Tab`
  - function keys
  - modified navigation keys like `Ctrl+Left` or `Alt+Right`
- This means `/terminal/input` is no longer needed for normal browser typing.
- If retained, it should be thought of as a temporary escape hatch for unmodeled human keys, not as the general upstream lane for emulator replies.

## Unknowns
- We have not yet verified the exact bytes emitted by xterm for the Codex startup sequence in the browser.
- We have not yet verified whether the Bud daemon / tmux injection path preserves `ESC ]` and BEL/ST bytes byte-for-byte.
- We have not yet verified whether tmux can faithfully deliver OSC 10 / 11 replies back to pane applications at all, or whether this class of reply is inherently unsupported in the current tmux-backed design.
- We have not yet verified whether the focus-triggered queries originate from Codex TUI itself, xterm focus reporting side effects, or some interaction between the two.

## Proposed Validation
1. Instrument the browser boundary to log the exact `emulator_protocol` bytes produced by xterm during Codex startup, ideally as escaped text plus hex.
2. Instrument the service raw-input path to confirm the exact bytes forwarded for `source: emulator_protocol`.
3. Validate at the Bud/tmux boundary whether the pane still receives the OSC introducers/terminators or only the printable payload.
4. Run one temporary experiment: drop or suppress OSC 10 / 11 replies in the browser and confirm whether:
   - the stray printable text disappears, and
   - Codex otherwise still starts, possibly with reduced color-awareness.

## Possible Fix Directions
- Stop forwarding `emulator_protocol` upstream by default; treat browser-generated terminal replies as unsupported unless explicitly allowlisted.
- Narrow raw emulator-protocol forwarding to an explicit allowlist of sequences we know work end-to-end in the browser + tmux stack.
- Suppress OSC 10 / 11 replies in the browser if tmux cannot faithfully deliver them to pane applications.
- If we need this capability, introduce a more faithful Bud-side terminal-reply path instead of treating emulator replies as equivalent to stdin-style pane input.
- Keep browser human typing and terminal-emulator replies as separate concepts all the way through the contract; the current issue is more evidence that "raw xterm `onData`" is not a safe universal upstream channel.
- If `/terminal/input` remains, narrow it to temporary unsupported-human-key fallback while we expand structured browser key coverage into `terminal_send.keys`.
