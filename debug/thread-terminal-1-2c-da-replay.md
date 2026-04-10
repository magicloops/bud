# Debug: thread terminal `1;2c` / DA replay on reconnect

## Environment
- Date: 2026-04-10
- Browser surface: existing thread workspace at [`web/src/routes/$budId/$threadId.tsx`](../web/src/routes/$budId/$threadId.tsx)
- Terminal stack: xterm.js in the web client, SSE terminal stream in the service, tmux-backed terminal sessions in the Bud daemon
- Review scope: the existing note in [`reference/unknown-terminal-input.md`](../reference/unknown-terminal-input.md), current thread-view terminal code, service terminal stream/input/history routes, terminal session manager, Bud terminal input path, and the locally installed xterm source

## Repro Steps
1. Open an existing thread with a live terminal session.
2. Switch away from the thread, switch browser tabs, or otherwise trigger the thread terminal reconnect/recovery path.
3. Return to the thread and watch the shell prompt.
4. Intermittently observe literal `1;2c`, sometimes repeated as `1;2c1;2c1;2c`.

## Observed
- The thread view forwards every xterm `onData(...)` emission directly to `POST /api/threads/:thread_id/terminal/input`: [`web/src/routes/$budId/$threadId.tsx#L651`](../web/src/routes/$budId/$threadId.tsx#L651)
- The same route restores terminal state by calling `term.reset()` and replaying persisted history through `term.write(decoded)`: [`web/src/routes/$budId/$threadId.tsx#L766`](../web/src/routes/$budId/$threadId.tsx#L766)
- xterm's Primary Device Attributes handler responds to `CSI c` by emitting `ESC[?1;2c` via `triggerDataEvent(...)`: [`web/node_modules/xterm/src/common/InputHandler.ts#L1633`](../web/node_modules/xterm/src/common/InputHandler.ts#L1633)
- The service terminal-input route and Bud daemon preserve input bytes end to end; neither side strips `ESC` before the shell sees the payload: [`service/src/routes/threads.ts#L862`](../service/src/routes/threads.ts#L862), [`service/src/runtime/terminal-session-manager.ts#L356`](../service/src/runtime/terminal-session-manager.ts#L356), [`bud/src/main.rs#L1070`](../bud/src/main.rs#L1070)
- Terminal reconnect currently has two replay paths with no dedupe:
  - terminal SSE attaches replay buffered events when no `lastEventId` is supplied: [`service/src/runtime/event-bus.ts#L58`](../service/src/runtime/event-bus.ts#L58)
  - the thread view then replays persisted `/terminal/history` again on `open`: [`web/src/routes/$budId/$threadId.tsx#L1518`](../web/src/routes/$budId/$threadId.tsx#L1518)
- The web client does not track terminal `byte_offset`, does not pass `last_event_id` on terminal SSE attach, and does not use `since_offset` even though the backend supports it: [`web/src/routes/$budId/$threadId.tsx#L1392`](../web/src/routes/$budId/$threadId.tsx#L1392), [`service/src/routes/threads.ts#L825`](../service/src/routes/threads.ts#L825), [`service/src/routes/threads.ts#L945`](../service/src/routes/threads.ts#L945)

## Expected
- Restoring historical terminal output should redraw the terminal only; it should not be forwarded back upstream as fresh stdin.
- Browser-generated terminal protocol replies should not be treated as human keystrokes.
- Reconnect should have one authoritative replay/backfill path instead of replaying both buffered SSE output and persisted history into the same xterm instance.

## Findings

### 1. The "missing ESC prefix" theory is weaker than the current implementation evidence

The note in [`reference/unknown-terminal-input.md`](../reference/unknown-terminal-input.md) points to the visible `1;2c` tail and suggests the frontend is losing `ESC[` before the sequence reaches the shell.

The current code path argues against that as the leading explanation:

- `decodeTerminalData(...)` base64-decodes bytes and runs them through `TextDecoder` without stripping control bytes: [`web/src/lib/api.ts#L235`](../web/src/lib/api.ts#L235)
- the service terminal-input route forwards the browser payload as `Buffer.from(input, "utf-8")`: [`service/src/routes/threads.ts#L881`](../service/src/routes/threads.ts#L881)
- the terminal session manager forwards that buffer as base64 to the Bud daemon: [`service/src/runtime/terminal-session-manager.ts#L387`](../service/src/runtime/terminal-session-manager.ts#L387)
- the Bud daemon decodes base64 and sends the resulting text literally to tmux: [`bud/src/main.rs#L1070`](../bud/src/main.rs#L1070)

There is no obvious stripping step in the reviewed path.

The stronger explanation is:

- xterm sees a replayed `CSI c`
- xterm generates the full DA reply `ESC[?1;2c`
- the app forwards that reply to the shell as input
- the shell/readline consumes the escape prefix as an input sequence and leaves the printable tail visible as `1;2c`

That fits the symptom without requiring upstream byte loss.

### 2. The note's main mechanism is directionally right, but the bug is broader than snapshot replay alone

The key frontend issue is not just "history replay is unsafe." It is "the route treats every xterm `onData(...)` emission as user stdin."

The thread view currently does this:

- register `term.onData((data) => sendTerminalInputRef.current(data))`: [`web/src/routes/$budId/$threadId.tsx#L651`](../web/src/routes/$budId/$threadId.tsx#L651)
- buffer and POST that data to `/terminal/input`: [`web/src/routes/$budId/$threadId.tsx#L682`](../web/src/routes/$budId/$threadId.tsx#L682)

But xterm `onData(...)` is not limited to typed keys. In the local xterm source it is also used for:

- DA replies such as `ESC[?1;2c`: [`web/node_modules/xterm/src/common/InputHandler.ts#L1633`](../web/node_modules/xterm/src/common/InputHandler.ts#L1633)
- focus reports `ESC[I` / `ESC[O` when enabled: [`web/node_modules/xterm/src/browser/Terminal.ts#L266`](../web/node_modules/xterm/src/browser/Terminal.ts#L266)
- window option reports such as `ESC[4;...t` and `ESC[6;...t`: [`web/node_modules/xterm/src/browser/Terminal.ts#L1267`](../web/node_modules/xterm/src/browser/Terminal.ts#L1267)

So the current bug class is broader than the original note: browser-generated terminal protocol responses are being forwarded to the host as if the human typed them.

### 3. Snapshot restore is still a concrete and likely trigger

`refreshTerminalSnapshot(...)` does:

1. fetch `/api/threads/:thread_id/terminal/history?bytes=131072`
2. `term.reset()`
3. `term.write(decoded)`

Code: [`web/src/routes/$budId/$threadId.tsx#L766`](../web/src/routes/$budId/$threadId.tsx#L766)

Because the `onData(...)` listener is already installed, any control query embedded in the restored history can cause xterm to emit a reply during restore, and that reply is immediately POSTed upstream.

This part of the original note remains plausible and is strongly supported by the current implementation.

### 4. The reconnect path likely amplifies the issue by replaying overlapping output more than once

The thread-view reconnect path currently does all of the following:

- opens terminal SSE with no resume cursor: [`web/src/routes/$budId/$threadId.tsx#L1392`](../web/src/routes/$budId/$threadId.tsx#L1392)
- writes any replayed `terminal.output` frames into xterm: [`web/src/routes/$budId/$threadId.tsx#L1415`](../web/src/routes/$budId/$threadId.tsx#L1415)
- on `open`, calls `recoverTerminalSession(...)`: [`web/src/routes/$budId/$threadId.tsx#L1518`](../web/src/routes/$budId/$threadId.tsx#L1518)
- recovery then calls `refreshTerminalSnapshot(...)`, which replays `/terminal/history` into xterm again: [`web/src/routes/$budId/$threadId.tsx#L818`](../web/src/routes/$budId/$threadId.tsx#L818)

On the server side, terminal SSE attach with no `lastEventId` replays the full buffered event list:

- `replay: buffer` when `lastEventId` is absent: [`service/src/runtime/event-bus.ts#L62`](../service/src/runtime/event-bus.ts#L62)

The combination means a reconnect can feed overlapping output back through xterm from:

- the in-memory SSE buffer
- the persisted terminal history snapshot

That makes the symptom intermittent and also explains the repeated `1;2c1;2c1;2c` cases better than a single one-off parser issue.

### 5. The backend already exposes primitives for incremental recovery, but the web thread view is not using them

The service already tracks and exposes terminal output offsets:

- terminal output events include `byte_offset`: [`service/src/runtime/terminal-session-manager.ts#L551`](../service/src/runtime/terminal-session-manager.ts#L551)
- `/terminal/history` accepts `since_offset`: [`service/src/routes/threads.ts#L953`](../service/src/routes/threads.ts#L953)
- the event bus supports `lastEventId` replay when the client supplies one: [`service/src/runtime/event-bus.ts#L70`](../service/src/runtime/event-bus.ts#L70)

The web thread view currently ignores all of that:

- `handleOutput(...)` discards `byte_offset` after decoding the payload: [`web/src/routes/$budId/$threadId.tsx#L1415`](../web/src/routes/$budId/$threadId.tsx#L1415)
- terminal SSE attach sends no `last_event_id`: [`web/src/routes/$budId/$threadId.tsx#L1392`](../web/src/routes/$budId/$threadId.tsx#L1392)
- history restore always requests the last `131072` bytes rather than `since_offset=<last_seen>`: [`web/src/routes/$budId/$threadId.tsx#L780`](../web/src/routes/$budId/$threadId.tsx#L780)

So reconnect falls back to coarse full replay instead of incremental recovery.

### 6. A restore-only guard would reduce the symptom, but it would not fully close the bug class

Adding an `isRestoringTerminalRef` guard around `refreshTerminalSnapshot(...)` would likely stop one concrete trigger path.

It would not address:

- xterm-generated protocol replies emitted during buffered SSE replay
- other non-user `onData(...)` emissions during normal live operation
- overlapping replay sources on reconnect

That means it is a reasonable short-term mitigation, but not a complete explanation or complete fix.

## Hypotheses
1. Some replayed terminal output includes `CSI c` or another query that causes xterm to emit an outbound protocol response.
2. xterm emits `ESC[?1;2c` during replay.
3. The thread-view `onData(...)` listener forwards that response to `/terminal/input`.
4. The shell/readline path consumes the escape prefix and leaves `1;2c` visible.
5. Multiple replay paths on reconnect multiply the symptom.

## Proposed Fix
- Short-term instrumentation:
  - log escaped/hex output from `term.onData(...)` before posting to `/terminal/input`
  - log whether the emission happened during snapshot restore, SSE-buffer replay, or normal foreground typing
  - log terminal `byte_offset` progression during reconnect so duplicate replay is easy to confirm
- Short-term mitigation:
  - suppress outbound forwarding while explicit restore/replay work is in progress
  - optionally drop known terminal-generated protocol replies such as DA/DSR/window-report sequences until input-source separation is in place
- Structural fix:
  - stop treating raw xterm `onData(...)` as synonymous with human keystrokes
  - make reconnect use a single recovery path
  - prefer incremental backfill using `since_offset` and/or stable terminal resume ids over replaying both SSE buffer and `/terminal/history`
  - consider aligning terminal-stream attach semantics with the newer agent stream model, where no-cursor attach is live-only instead of replay-all

## Suggested Validation
- Add temporary logging around [`web/src/routes/$budId/$threadId.tsx#L651`](../web/src/routes/$budId/$threadId.tsx#L651) and confirm whether the browser emits `\x1b[?1;2c`.
- Compare reconnect behavior with history replay disabled vs enabled.
- Force repeated reconnects and verify whether duplicate `byte_offset` ranges or duplicate history replays line up with repeated `1;2c` tails.
- After any mitigation, verify that normal typing, paste, Enter, and Ctrl+C still behave correctly.

## Spec Files Affected
- [`bud.spec.md`](../bud.spec.md) for root debug-doc indexing
