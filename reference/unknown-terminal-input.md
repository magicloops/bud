What is 1;2c in terms of terminal character codes? We have a browser-based terminal viewer, and there's an odd bug, where when we switch pages/views and come back to the terminal view, it adds one or more 1;2c texts to the shell input

--- 

`1;2c` isn’t random text—it’s almost certainly a **fragment of an ANSI/VT escape sequence** that got stripped of its leading control characters.

### What it actually is

In a proper terminal control sequence, this would be:

```
ESC [ 1 ; 2 c
```

That is:

* `ESC` = `\x1b`
* `[` = Control Sequence Introducer (CSI)

So the full sequence is:

```
\x1b[1;2c
```

### Meaning

This is a **Device Attributes (DA) response** from the terminal.

More specifically:

* `ESC [ ... c` = *“Send Device Attributes”* (or response to it)
* `1;2` are parameters describing terminal capabilities

Typical meanings (vary slightly by terminal):

* `1` → “VT100-compatible”
* `2` → “Advanced video options / ANSI support”

So:
👉 `\x1b[1;2c` = *“I am a VT100 with advanced features”*

---

### Why you're seeing `1;2c` in your shell input

This is the key bug:

👉 Your terminal viewer is **dropping or not interpreting the escape prefix (`\x1b[`)**, leaving only the raw payload `1;2c`.

That means:

* The terminal (or shell) sends a DA request:

  ```
  \x1b[c
  ```
* Your terminal emulator responds:

  ```
  \x1b[1;2c
  ```
* But your frontend:

  * either **fails to treat it as a control sequence**, or
  * **loses the ESC (`\x1b`) during buffering / rehydration**

So it ends up inserting literal text:

```
1;2c
```

into the input stream.

---

### Why it happens on view switch

This is a classic symptom of:

* Terminal reinitialization / reattachment
* PTY reflow or replay
* Lost parser state

Likely causes:

1. **Buffered output replayed as plain text**

   * Escape sequences split across chunks
   * Parser not stateful across remount

2. **Missing ESC during serialization**

   * `\x1b` stripped or not preserved

3. **Terminal re-querying device attributes**

   * Some shells or libraries send `ESC[c` on startup or resize

4. **xterm.js / emulator not fully reset**

   * Parser mid-sequence when component unmounts

---

### What to check / fix

#### 1. Ensure escape sequences are preserved

Make sure `\x1b` is not being:

* dropped
* HTML-escaped incorrectly
* split across frames without reassembly

#### 2. Use a proper ANSI parser (stateful)

If using something like **xterm.js**, ensure:

* you're not feeding partial chunks incorrectly
* you're not writing directly to DOM bypassing parser

#### 3. Avoid writing terminal output into input buffer

This often happens if:

* stdout and stdin streams get mixed
* replay logic writes output as keystrokes

#### 4. Reset parser state on remount

If using xterm.js:

```js
term.reset()
```

or recreate terminal cleanly

#### 5. Log raw bytes

Inspect what’s actually coming through:

```js
console.log([...data].map(c => c.charCodeAt(0)))
```

You should see:

```
27, 91, 49, 59, 50, 99
```

If instead you see:

```
49, 59, 50, 99
```

👉 the ESC (`27`) is already gone upstream.

---

### TL;DR

* `1;2c` = tail of `\x1b[1;2c` (terminal device attributes response)
* It’s showing up because your terminal viewer is **losing the escape prefix**
* The bug is almost certainly in **ANSI parsing, buffering, or remount handling**

---

[Link to file](web/src/routes/$budId/$threadId.tsx)

--- 

I think I found the likely mechanism.

The biggest red flag is that your `onData` handler forwards **everything xterm emits** straight to the backend input endpoint:

```ts
dataListener = term.onData((data) => {
  if (data.length > 0) {
    sendTerminalInputRef.current(data)
  }
})
```

At the same time, when the terminal reconnects or restores state, you replay terminal history back into xterm:

```ts
term.reset()
const decoded = body.data_base64 ? decodeTerminalData(body.data_base64) : ''
if (decoded) {
  term.write(decoded)
}
```

Both of those behaviors are in this file. 

Why that matters:

* `ESC [ c` is a **Device Attributes** query.
* When xterm receives that query via `term.write(...)`, it can generate a response like `ESC [ ? 1 ; 2 c` internally.
* That response comes out through `onData`, because from xterm’s point of view it is outbound terminal input to the host.
* Your code then blindly POSTs that response back to the shell as if the user typed it. 

So the probable flow is:

1. You leave and come back to the terminal view.
2. `refreshTerminalSnapshot()` replays saved terminal output with `term.write(decoded)`.
3. That replay includes a DA request (`ESC[c`) somewhere in the history or bootstrap output.
4. xterm answers it.
5. Your `term.onData(...)` handler forwards the answer to `/terminal/input`.
6. The shell ends up seeing literal `1;2c` or similar junk in stdin. 

That would also explain why it happens specifically on restore/reconnect/view switching, not only during live typing.

A couple of things make this diagnosis fit especially well:

* You call `recoverTerminalSession(...)` on SSE open and on reconnect paths, then `refreshTerminalSnapshot(...)` after recovery. That means terminal history gets replayed during exactly the lifecycle where you see the bug. 
* The code does not distinguish between:

  * **real user keystrokes**
  * **terminal-generated protocol responses**
    It forwards both. 

What I would change first:

1. **Guard input forwarding during snapshot replay**
   Add a ref like `isRestoringTerminalRef`.
   Set it `true` before `term.reset(); term.write(decoded)`, and `false` after the write settles.
   Then ignore `onData` while restore is in progress.

Conceptually:

```ts
const isRestoringTerminalRef = useRef(false)

dataListener = term.onData((data) => {
  if (isRestoringTerminalRef.current) return
  if (data.length > 0) {
    sendTerminalInputRef.current(data)
  }
})
```

and:

```ts
isRestoringTerminalRef.current = true
term.reset()
term.write(decoded, () => {
  isRestoringTerminalRef.current = false
})
```

2. **Optionally filter terminal-generated DA replies**
   Even outside replay, you may want to drop known auto-generated responses such as:

   * `\x1b[?1;2c`
   * maybe other DSR/DA responses

3. **Log raw outbound data from `onData`**
   Log escaped bytes so you can confirm whether xterm is sending:

   * `\x1b[?1;2c`
   * `\x1b[1;2c`
   * or only `1;2c`

That will tell you whether the mangling happens:

* inside xterm replay,
* in `sendTerminalInput`,
* on the backend,
* or in shell echo/rendering.

My confidence is pretty high that the core bug is: **restored terminal output is being reinterpreted by xterm as live control input, and xterm’s protocol response is being forwarded as user stdin.** 

The first place I’d patch is the combination of `term.onData(...)` plus `refreshTerminalSnapshot()`.

