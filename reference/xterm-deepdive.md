We're working on an agentic system where a daemon (Bud) is installed on a machine, and it manages multiple tmux sessions, proxying input back-and-forth to our backend service, which in turn proxies to our front-end client. Our primary use case is having an AI agent send commands to the tmux sessions, but we also offer an "escape hatch" such that the end user can see the tmux session in their web browser, using xterm.js. 

We had a strange issue, where when we would refocus the browser/xterm.js, characters were sent to the terminal. In one case it was the sequence `1;2c` (often repeated) and in another case (using a TUI) was `10;rgb:d1d1/ffff/e1e111;rgb:0000/0000/000010;`. The latter case happened every time we refocused the xterm view, without switching pages/tabs/refreshing.


On engineer analyzed this as: 
```
We have a browser-boundary bug, not a tmux bug.

The current pipeline is:

```text
xterm onData -> browser buffer -> /terminal/input -> terminal_input -> tmux send-keys
```

That pipeline assumes every outbound xterm byte is human intent. That assumption is false. xterm can emit protocol replies on its own, and the downstream layers do not carry enough information to recover the original source.

Once the service receives only a string payload:

- it cannot know whether `\x1b[12;40R` is a human Alt-sequence or a cursor-position report
- Bud (our on-device daemon that proxies to tmux) cannot know either
- tmux receives the bytes as if the human typed them

The only reliable place to fix this is the browser boundary, before the bytes are collapsed into a generic `input` string.
```

This seems to make sense to us, but it also feels like a hack. Shouldn't the emulator replies be used in some way? Is it our converstion to UTF-8 that's breaking the normal flow? What's the proper way to set up xterm.js connected to a remote tmux session? 

Yes — the analysis is basically right, but the deeper problem is not “xterm.js is weird.” It is that your system is using one pipe for two different things:

1. **terminal transport**: opaque bytes between an application and a terminal emulator
2. **human intent**: “the user pressed Ctrl-C” or “the user typed `ls`”

`xterm.onData` belongs to the first category, not the second. xterm.js documents `onData` as the stream that, in a typical setup, should be passed to the backing PTY, and its `input(data, wasUserInput?)` API explicitly distinguishes “data to the application” from “genuine user input.” That is a strong hint that `onData` is an **application-input channel**, not a guaranteed keystroke log. ([xtermjs.org][1])

The sequences you saw look like normal terminal protocol, not ghost typing. `1;2c` is very likely the printable tail of xterm’s primary Device Attributes reply `CSI ? 1 ; 2 c`, and `10;rgb:...` matches OSC 10/11 foreground/background color query replies. xterm.js says it supports Primary DA plus OSC 10/11/12 queries, and it also supports focus mode 1004. In xterm protocol, when focus reporting is enabled, the terminal sends `CSI I` on focus and `CSI O` on blur. tmux also has a `focus-events` option that requests focus events from the client terminal and passes them through to applications running inside tmux. ([xfree86.org][2])

So to your first question: **yes, emulator replies should be used** — when you have a real terminal connection. They belong on the stdin of the PTY/tmux client that asked for them. They should **not** be reinterpreted later as “literal user-typed characters” and forwarded via a higher-level API like `tmux send-keys`. That is the category error in your current design. xterm’s own README shows the normal model as PTY output → `term.write(...)` and `term.onData(...)` → PTY stdin, while tmux separately provides a text-only control mode for programmatic control. Those are two different planes. ([GitHub][3])

Your UTF-8 conversion is probably **not** the root cause. xterm.js says `onData` emits normal JS string data that should be converted to UTF-8 for OS interaction, and `onBinary` exists for the small class of non-UTF-8 reports it still emits (currently legacy mouse reports). The sequences you posted are mostly ASCII control sequences, so plain UTF-8 encoding preserves them fine. The breakage is much more likely to be **loss of framing and provenance**, not UTF-8 itself. xterm maintainers also note that client→server text input normally goes as text from `onData`, while binary input should stay separate via `onBinary`. ([xtermjs.org][4])

The proper way to wire **xterm.js to a remote tmux session** is:

* On Bud, create a **real PTY per browser attachment**.
* Run `tmux attach-session -t <session>` inside that PTY.
* PTY output goes to the browser and is rendered with `term.write(...)`.
* Browser terminal input goes back to **that PTY’s stdin**.
* Resize is a separate message that resizes the PTY/tmux client.
* `onBinary` stays distinct from `onData`.
* Over WebSockets, use explicit framing and backpressure rather than an untyped string pipe. xterm’s flow-control guide specifically calls out the need for a custom message protocol over websockets, and its security guide warns against treating the demo/attach addon as a production websocket design. ([GitHub][3])

In other words, the browser path should look more like:

```text
PTY stdout/stderr -> websocket -> xterm.write(...)
xterm.onData      -> websocket(stdin-text)   -> PTY stdin
xterm.onBinary    -> websocket(stdin-binary) -> PTY stdin
xterm.onResize    -> websocket(resize)       -> PTY resize
```

That PTY is where tmux expects terminal semantics to exist.

For your **AI/control plane**, keep it separate. tmux control mode (`tmux -C` / `-CC`) is explicitly designed as a text-only application interface: commands go in, structured output and notifications come out. That is a far better place for AI orchestration, pane inspection, session management, and machine-friendly control than trying to infer meaning from xterm transport bytes. ([GitHub][5])

That leads to the clean architecture:

* **Human web terminal**: xterm.js ↔ PTY ↔ `tmux attach`
* **AI/system control**: tmux control mode or tmux commands/API
* **Never** collapse those two into one generic `input: string` message

About the engineer’s proposed “browser boundary fix”: it is **not** a hack if your goal is to recover **human intent**. It is the only place where provenance still exists. xterm.js’s `attachCustomKeyEventHandler` runs **before** keys are processed and gives you control over whether xterm handles them, so it is a reasonable place to capture actual keyboard intent for analytics, policy, or auditing. But that should be an **extra side channel**, not your terminal transport. Once you rely on it as the transport, you are accepting a degraded terminal model that will never fully match a PTY-backed client for paste, focus reports, color queries, mouse protocols, IME behavior, and similar features. ([xtermjs.org][1])

So my recommendation is:

* Treat `onData`/`onBinary` as **terminal stdin**, not “the user typed this.”
* Stop wiring xterm directly to `tmux send-keys` for the interactive browser session.
* Spawn a PTY-backed tmux client for every browser terminal.
* Keep AI/user-intent capture as a separate, typed channel.
* Use tmux control mode or tmux commands for machine control.

A useful next refactor is to make your websocket protocol explicit: `pty-output`, `stdin-text`, `stdin-binary`, `resize`, and optionally `intent-key` / `intent-paste`.

[1]: https://xtermjs.org/docs/api/terminal/classes/terminal/ "Terminal"
[2]: https://www.xfree86.org/current/ctlseqs.html "Xterm Control Sequences"
[3]: https://github.com/xtermjs/xterm.js/blob/master/README.md "xterm.js/README.md at master · xtermjs/xterm.js · GitHub"
[4]: https://xtermjs.org/docs/guides/encoding/ "Encoding"
[5]: https://github.com/tmux/tmux/wiki/Control-Mode "Control Mode · tmux/tmux Wiki · GitHub"

