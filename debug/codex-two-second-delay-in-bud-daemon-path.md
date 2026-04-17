# Debug: Codex two-second delay in the Bud daemon path

## Environment

- Local Bud daemon, service, and web UI
- Browser terminal input path: `POST /api/threads/:threadId/terminal/input`
- Browser terminal output path: Bud `terminal_output` -> service `terminal.output` SSE -> xterm.js
- Original user-provided Bud logs were from pressing Enter in an already-running Codex session

## Problem statement

We initially suspected that Codex startup inside Bud/tmux was slower than in a local terminal. After more testing, that appears to be a red herring.

The more precise issue is:

- after pressing Enter in the Bud terminal, the first two `terminal_output` chunks arrive quickly
- then there is about a 2 second gap before the next larger, visibly meaningful output chunk
- this same delay is reflected in the browser terminal

The question for this note is:

**What exact Bud daemon logic could be causing that 2 second gap?**

## User-provided Bud logs

```text
2026-04-16T20:26:22.858162Z  INFO tmux send-keys succeeded ...
2026-04-16T20:26:22.908706Z  INFO new output detected ... size=2149161 current_offset=2149150
2026-04-16T20:26:22.908862Z  INFO sending terminal_output ... seq=449 bytes=11
2026-04-16T20:26:22.961142Z  INFO new output detected ... size=2149201 current_offset=2149161
2026-04-16T20:26:22.961275Z  INFO sending terminal_output ... seq=450 bytes=40
2026-04-16T20:26:24.950512Z  INFO new output detected ... size=2150886 current_offset=2149201
2026-04-16T20:26:24.952636Z  INFO sending terminal_output ... seq=451 bytes=1685
```

Observed shape:

- Enter dispatch completed immediately
- Bud emitted 11 bytes at about `+50ms`
- Bud emitted 40 bytes at about `+100ms`
- Bud did **not** see another log-file growth event until about `+2.0s`

That means the 2 second gap is already visible at the daemon watcher level. This is important because it narrows the problem significantly.

## Relevant Bud daemon path

### 1. Browser Enter goes through `terminal_input`, not agent `terminal.send`

Relevant files:

- [threads.ts](/Users/adam/bud/service/src/routes/threads.ts:863)
- [terminal-session-manager.ts](/Users/adam/bud/service/src/runtime/terminal-session-manager.ts:365)
- [main.rs](/Users/adam/bud/bud/src/main.rs:1104)

Flow:

1. Browser posts `/api/threads/:threadId/terminal/input`
2. Service `sendInput(...)` forwards `terminal_input` to Bud
3. Bud `handle_input(...)` decodes bytes and sends them to tmux immediately

For an Enter-only input, Bud splits text vs newline and sends just the tmux `Enter` key.

### 2. Browser input does request readiness, but that is a separate event path

One subtle but important detail:

- `sendInput(...)` always includes `await_ready.enabled: true`
- when the terminal context is `repl`, it also sets `activity_based: true`
- that REPL mode uses `activity_initial_delay_ms: 2000`

Relevant file:

- [terminal-session-manager.ts](/Users/adam/bud/service/src/runtime/terminal-session-manager.ts:394)

So there really is a Bud-side 2 second timer in this browser-input flow.

But it only drives the daemon's later `terminal_ready` event. It does **not** block or batch the raw `terminal_output` stream that the browser terminal renders.

## Important Bud-side distinction

There **is** a 2 second constant in the daemon:

- [main.rs](/Users/adam/bud/bud/src/main.rs:330) `ACTIVITY_DEFAULT_INITIAL_DELAY_MS = 2000`

But that constant is only used by the **activity-based readiness detector**, not by the raw terminal output stream:

- [main.rs](/Users/adam/bud/bud/src/main.rs:1190)
- [main.rs](/Users/adam/bud/bud/src/main.rs:3383)

That detector only affects `terminal_ready` timing. It does **not** gate `terminal_output` emission to the browser terminal.

So:

- the 2 second activity-detector constant is real
- but it is **not** the direct cause of xterm receiving `terminal.output` late

## Raw output streaming path

Relevant file:

- [main.rs](/Users/adam/bud/bud/src/main.rs:2988)

The Bud output watcher:

- watches the `pipe-pane` log file
- checks the file size every `50ms`
- when `size > current_offset`, it immediately reads the new bytes
- immediately sends a `terminal_output` frame

Relevant 50ms polling locations:

- [main.rs](/Users/adam/bud/bud/src/main.rs:3051)
- [main.rs](/Users/adam/bud/bud/src/main.rs:3098)
- [main.rs](/Users/adam/bud/bud/src/main.rs:3111)

This means the watcher can add roughly:

- one polling interval of latency
- maybe two in unlucky alignment cases

But that is on the order of:

- `50-100ms`

not:

- `2000ms`

### Exact daemon decision loop

The output watcher is effectively doing this:

```text
loop:
  size = stat(log_path).len
  current_offset = offset.load()

  if size > current_offset:
    read bytes[current_offset..size]
    offset = size
    last_output_at = now
    last_output_seq = next_seq
    send terminal_output immediately

  sleep 50ms
```

That exact logic matters for interpreting the user's logs:

- `new output detected` is only logged inside the `size > current_offset` branch
- `sending terminal_output` happens in the same branch, right after the bytes are read

So if there is a 2 second gap between those logs, the daemon-level meaning is very narrow:

**for roughly 2 seconds, the pipe-pane log file did not grow past the last observed offset**

This is a stronger conclusion than "Bud looked idle." It means the watcher did not observe additional bytes to send during that window.

## First conclusion

The Bud daemon does **not** contain a 2 second buffering delay in the raw terminal output path.

For this specific browser terminal path:

- `handle_input(...)` dispatches Enter immediately
- `spawn_output_watcher(...)` polls every `50ms`
- `terminal_output` frames are emitted as soon as new bytes are present
- browser xterm writes only from `terminal.output` SSE payloads, not from `terminal.ready`

So if the daemon logs show a 2 second gap between output chunks, the most likely meaning is:

**the underlying tmux pane did not write any additional bytes that Bud could observe during that window**

## Updated reproduction and correction

The earlier version of this note overfit one detached-tmux repro and attributed the `~2s` gap to the Codex update operation itself. That conclusion is too strong and does not match the newer evidence.

What the newer evidence shows instead:

- the same slow path can happen before the update screen is even rendered
- killing Codex before the update actually runs still leaves the `2-5s` startup delay
- starting `codex` in a fresh tmux session outside Bud can show the same behavior
- the latency is variable: sometimes `200-400ms`, sometimes `2s+`, sometimes closer to `5s`

That means the issue is broader than "Bud triggered the update path."

## Interpretation of the newer Bud logs

Two new traces are especially useful.

### Case A: first substantive draw after about `2.8s`

```text
20:53:10.167 send-keys succeeded
20:53:10.204 terminal_output 11 bytes
20:53:10.257 terminal_output 40 bytes
20:53:12.704 terminal_output 22 bytes
20:53:12.964 terminal_output 1769 bytes
...
20:53:15.256 terminal_output 140 bytes
```

Observed shape:

- immediate dispatch
- two tiny chunks within `100ms`
- then about `2.45s` of near-silence
- then a small `22` byte chunk
- then the first large visible draw (`1769` bytes)
- then several follow-up chunks over another `2.3s`

### Case B: first substantive draw after about `2.5s`

```text
20:54:36.248 send-keys succeeded
20:54:36.271 terminal_output 11 bytes
20:54:36.375 terminal_output 40 bytes
20:54:38.404 terminal_output 22 bytes
20:54:38.716 terminal_output 1713 bytes
...
20:54:40.849 terminal_output 140 bytes
```

Observed shape:

- same early `11` then `40` byte chunks
- about `2.0s` before a `22` byte chunk
- about `300ms` later, the first large visible draw
- then continued incremental output for another `2.1s`

These traces change the interpretation:

1. Bud is still forwarding output promptly.
2. Codex is emitting a repeatable sparse early sequence.
3. The main screen draw does not begin immediately after Enter.
4. The startup/render path remains active for several more seconds after the first large draw.

So the better summary is:

- not "Bud buffered for 2 seconds"
- not "the update action itself took 2 seconds"
- but "Codex under tmux is often taking a sparse, variable startup path before the first substantive screen paint"

## What the Bud daemon is and is not doing

### Bud **is** doing

- immediate `tmux send-keys` dispatch for Enter
- `50ms` log polling
- immediate `terminal_output` forwarding when file size increases
- separate readiness detection in parallel, including a `2000ms` initial delay for REPL activity-based waits

### Bud is **not** doing

- buffering terminal output for 2 seconds before forwarding
- waiting for readiness detection before forwarding `terminal_output`
- delaying the raw browser terminal stream on the `ACTIVITY_DEFAULT_INITIAL_DELAY_MS` timer

## Strongest current hypothesis

For the current logs, the strongest supported conclusion is:

**Bud is not introducing the multi-second delay in the raw output stream; Codex running inside tmux is often not producing its first substantive screen draw until `2-5s` after the initial tiny control/status writes.**

What remains unresolved is why that tmux startup path is sometimes fast and sometimes slow.

## Remaining Bud-daemon-adjacent hypothesis

There are still a few tmux-adjacent hypotheses worth keeping in mind:

- Codex may be issuing terminal capability or cursor-position queries and waiting on a reply or timeout before doing the first full draw.
- `TERM=tmux-256color`, `TERM_PROGRAM=tmux`, or other tmux-specific env may be taking Codex down a different startup path than the user's normal shell tab.
- Some startup check inside Codex may be intermittent or timing-sensitive under tmux, which would fit the observed `200ms` vs `2s` vs `5s` spread.

What the newer evidence weakens is the earlier detached-only hypothesis:

- this is not well explained by "Bud uses detached tmux"
- because the user can reproduce something similar in a regular tmux session outside Bud

So the current center of gravity is:

- Codex/tmux interaction
- not Bud's output watcher

## Why the browser felt like it got nothing until 2s

The early Bud chunks were only `11` and `40` bytes, followed later by a `22` byte chunk.

Those are small enough that they were probably:

- control sequences
- cursor state toggles
- tiny fragments of status output

So even though Bud did emit output almost immediately, the browser may not have shown anything obviously meaningful until the `1700`-byte range chunk arrived.

## Recommended next checks

### 1. Capture the actual small-byte payloads

The repeated `11`, `40`, and `22` byte pattern is now a key clue.

Temporarily log:

- the raw escaped bytes for very small `terminal_output` chunks
- and a printable-stripped summary

That would tell us whether these are:

- terminal queries
- cursor-position reports
- OSC/CSI control traffic
- or tiny human-visible status strings

### 2. Compare tmux env and terminal identity against the non-tmux shell

The attached-tmux repro makes Bud-specific transport logic a weaker suspect. The next high-value comparison is:

- `TERM`
- `TERM_PROGRAM`
- `COLORTERM`
- shell mode / login mode
- any Codex-specific env or config path differences

Then rerun `codex` under matched env where possible.

### 3. Check whether the repeated gap matches timeout-like behavior

The `~2.0s`, `~2.45s`, and occasional `~5s` delays are suggestive of timeout or retry behavior.

That is worth testing directly against hypotheses like:

- terminal capability query timeouts
- update-check or startup probe retries
- delayed redraw after an initial hidden-mode transition

### 4. Revisit the detached-client tmux model only as a secondary factor

Detached tmux may still matter, but it is no longer the leading explanation.

If needed, the remaining daemon-adjacent investigation would be:

- what terminal queries Codex emits
- whether attached vs detached tmux changes reply behavior
- whether Bud eventually needs a real PTY/client model rather than detached tmux plus `send-keys`

## Caveat

During the earlier detached reproduction, pressing Enter on the update chooser accepted the default update action and upgraded local Codex from `0.120.0` to `0.121.0`.

That still affects local reproducibility, but it should no longer be treated as the primary explanation for the original multi-second gap.

## Relevant code references

- Browser input route: [threads.ts](/Users/adam/bud/service/src/routes/threads.ts:863)
- Service `sendInput(...)`: [terminal-session-manager.ts](/Users/adam/bud/service/src/runtime/terminal-session-manager.ts:365)
- Service REPL `await_ready` config: [terminal-session-manager.ts](/Users/adam/bud/service/src/runtime/terminal-session-manager.ts:394)
- Service emits browser terminal events: [terminal-session-manager.ts](/Users/adam/bud/service/src/runtime/terminal-session-manager.ts:587)
- Browser terminal SSE route: [threads.ts](/Users/adam/bud/service/src/routes/threads.ts:826)
- Browser xterm writes `terminal.output`: [\$threadId.tsx](/Users/adam/bud/web/src/routes/$budId/$threadId.tsx:1509)
- Bud `handle_input(...)`: [main.rs](/Users/adam/bud/bud/src/main.rs:1104)
- Bud activity-detector 2s constant: [main.rs](/Users/adam/bud/bud/src/main.rs:330)
- Bud output watcher: [main.rs](/Users/adam/bud/bud/src/main.rs:2988)

## Interim conclusion

The exact Bud daemon logic does **not** point to a built-in 2 second stream delay.

Instead, the daemon path points to this:

- the watcher is fast
- the first output bytes arrive fast
- the first **meaningful** output can still arrive `2-5s` later because Codex-in-tmux is taking a sparse and variable startup/render path before the first full screen draw

The prior version of this note incorrectly pinned that delay on the update operation itself. The newer traces do not support that. What they do support is narrower:

- raw Bud streaming is prompt
- Codex under tmux is often slow to produce its first substantial paint
- the exact Codex/tmux reason is still unresolved
