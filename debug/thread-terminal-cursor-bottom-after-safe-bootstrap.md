# Debug: thread-terminal cursor sits at bottom after safe bootstrap

## Environment
- Local web + service development on the thread view (`/$budId/$threadId`)
- Browser terminal uses xterm.js with the new safe `/api/threads/:thread_id/terminal/state` bootstrap path
- Regression observed after the thread-terminal-boundaries changes; no code changes made in this note

## Repro Steps
1. Open a thread with an existing terminal session and visible shell prompt/output.
2. Leave the page or browser tab, then return to the same thread view.
3. Wait for the thread view to rebuild the terminal from `/api/threads/:thread_id/terminal/state`.
4. Observe that the blinking xterm cursor appears on the bottom row of the viewport instead of at the prompt/input line.

## Observed
- Terminal text appears broadly correct enough to show recent shell content.
- The blinking cursor is visually detached from the latest prompt/input location.
- The cursor is rendered at the bottom of the terminal viewport, which makes the shell look idle on one row while the caret blinks elsewhere.

## Expected
- After thread reopen or reconnect, the xterm cursor should visually trail the latest prompt/input location.
- The browser terminal should not imply a different insertion point than the remote shell's actual cursor position.

## Relevant Implementation
- [`web/src/routes/$budId/$threadId.tsx`](../web/src/routes/$budId/$threadId.tsx)
  - `loadTerminalState(...)` fetches `/terminal/state` and calls `terminalController.applyStateSnapshot(...)`
  - `recoverTerminalSession(...)` reloads safe state before attaching the stream
  - xterm fit/resize happens separately from snapshot application
- [`web/src/lib/thread-terminal-controller.ts`](../web/src/lib/thread-terminal-controller.ts)
  - `applyStateSnapshot(...)` calls `terminal.reset()` and then writes `state.snapshot.text` directly into xterm
  - `lastRenderedByteOffset` is advanced to `latest_byte_offset` before live output resumes
- [`service/src/routes/threads.ts`](../service/src/routes/threads.ts)
  - `/terminal/state` returns `snapshot.text` from `terminalSessionManager.capturePane(...)` when the Bud is online

## Hypotheses
1. **The safe snapshot is text-only and loses the real cursor position.**
   - `applyStateSnapshot(...)` rebuilds xterm from `snapshot.text` alone, but that payload does not appear to include explicit cursor row/column state.
   - If `capturePane(...)` returns a rectangular dump of visible lines, xterm will place its cursor after the last written character, not at the shell's true cursor location.

2. **The snapshot likely includes trailing blank pane rows below the prompt.**
   - A tmux pane capture often reflects the full visible pane, not just content up to the live cursor.
   - If the prompt is on row N and rows `N+1..bottom` are blank, replaying the raw captured text into xterm would naturally leave the cursor at or near the viewport bottom.

3. **We now suppress the exact output bytes that originally positioned the cursor.**
   - `applyStateSnapshot(...)` sets `lastRenderedByteOffset = latest_byte_offset` before live streaming resumes.
   - That means the client intentionally does not replay the most recent terminal output bytes after the safe snapshot, so any control sequences that had previously established the real prompt/cursor position never get reapplied in xterm.

4. **Fit/resize may be happening after snapshot reconstruction and changing the layout under the cursor.**
   - The route initializes xterm, fits it asynchronously, and also sends resize updates independently.
   - If the terminal is written before final dimensions settle, wrapped lines and cursor row placement can diverge from the original pane layout, leaving the cursor on the final rendered row.

5. **Tab/page return may need an explicit post-visibility refit.**
   - The thread view fits on initial mount, window resize, and thread-panel changes, but there is no explicit `visibilitychange` or tab-restore refit path.
   - If browser tab suspension/restoration changes xterm's measured cell geometry, the renderer may repaint the cursor at the wrong vertical position until a later fit occurs.

## Proposed Next Checks
- Compare `snapshot.text` with the actual shell cursor row by logging whether the capture includes blank trailing lines below the prompt.
- Inspect whether tmux capture can expose cursor coordinates in addition to visible text; if so, confirm whether the browser is currently discarding that information.
- Force a `fitTerminal()` immediately after `applyStateSnapshot(...)` completes and again on browser `visibilitychange` to test the layout hypothesis.
- Temporarily allow a small durable replay window after snapshot bootstrap to see whether replaying the latest real terminal bytes restores the cursor to the expected row.
- Capture a screenshot plus the exact `snapshot.text` payload for one bad restore so we can distinguish "bad geometry" from "missing cursor state".
