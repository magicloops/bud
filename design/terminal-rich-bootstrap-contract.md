# Design: Terminal Rich Bootstrap Contract

Status: Draft

Audience: Web, service, daemon

Last updated: 2026-04-13

Related:
- [`debug/thread-terminal-cursor-bottom-after-safe-bootstrap.md`](../debug/thread-terminal-cursor-bottom-after-safe-bootstrap.md)
- [`design/terminal-human-input-boundaries-and-replay-semantics.md`](./terminal-human-input-boundaries-and-replay-semantics.md)
- [`design/browser-terminal-typing-latency-and-send-modes.md`](./browser-terminal-typing-latency-and-send-modes.md)
- [`plan/thread-terminal-boundaries/phase-3-terminal-state-bootstrap-and-reference-web-adoption.md`](../plan/thread-terminal-boundaries/phase-3-terminal-state-bootstrap-and-reference-web-adoption.md)

## 1. Goal

Evolve terminal bootstrap from a safe but text-only snapshot into a richer, cursor-aware contract that can reopen shell and TUI sessions accurately without returning to raw historical replay.

The contract should preserve the good parts of the current design:

- bootstrap is separate from live output replay
- bootstrap is safe to feed into xterm
- reconnect uses `latest_byte_offset` for durable resume

But it must stop assuming that "some captured text" is enough to reconstruct a live terminal screen.

## 2. Current Implementation Review

The current bootstrap path works like this:

1. The browser fetches `GET /api/threads/:thread_id/terminal/state`.
2. The service returns:
   - `session_id`
   - `state`
   - `latest_byte_offset`
   - `readiness`
   - `snapshot: { text, source }`
   - `updated_at`
3. The browser resets xterm and writes `snapshot.text`.
4. The browser sets `lastRenderedByteOffset = latest_byte_offset`.
5. The browser attaches `GET /terminal/stream?after_offset=<latest_byte_offset>`.

Verified details from the current implementation:

- [`service/src/routes/threads.ts`](../service/src/routes/threads.ts)
  - `/terminal/state` currently builds `snapshot.text` from `terminalSessionManager.capturePane(sessionId, { startLine: -200 }, 2500)`.
  - The route returns `latest_byte_offset` from `terminal_session.total_output_bytes`.
- [`service/src/runtime/terminal-session-manager.ts`](../service/src/runtime/terminal-session-manager.ts)
  - `capturePane(...)` currently delegates to `observeTerminal(..., { view: "history", waitFor: "none", lines: -200 })`.
- [`bud/src/main.rs`](../bud/src/main.rs)
  - the actual tmux capture path currently runs `tmux capture-pane -p -J -t <session> [-S <start>]`.
- [`web/src/lib/thread-terminal-controller.ts`](../web/src/lib/thread-terminal-controller.ts)
  - `applyStateSnapshot(...)` resets xterm, trims trailing blank lines as a temporary experiment, then writes plain text into xterm.
  - the browser does not replay any terminal bytes before `latest_byte_offset` after bootstrap.

So the current contract is already capture-pane-backed. The problem is not "we should use capture-pane instead of snapshot."

The problem is that the current snapshot is:

- text-only
- history-flavored rather than explicitly "current visible screen"
- missing cursor state
- missing pane geometry
- missing screen mode
- currently flattened by `capture-pane -J`, which joins wrapped lines

## 3. What The Current Contract Gets Right

- It removed the unsafe raw-history bootstrap path that was provoking xterm protocol replies.
- It keeps bootstrap separate from durable live replay.
- It makes reopen/reconnect deterministic with `latest_byte_offset`.
- It works well enough for many shell-prompt restores.

Those are real wins and should be preserved.

## 4. Why It Breaks For Cursor Fidelity And TUIs

The current contract loses too much information.

### 4.1 Cursor position is absent

The browser only receives text. xterm therefore puts its cursor at the end of what was written, not at the pane's actual cursor position.

### 4.2 Visible screen and history are conflated

The service helper currently bootstraps through `view: "history"` with `startLine: -200`, which is useful for context but is not the same thing as "the exact current visible screen."

### 4.3 Wrapped rows are flattened

The daemon uses `tmux capture-pane -J`, and tmux documents that `-J` "joins any wrapped lines." That means the current bootstrap payload is not an exact row-for-row screen grid.

### 4.4 Alternate-screen / mode state is absent

A shell prompt and a fullscreen TUI are not equivalent bootstrap targets. The current payload does not say whether the pane is:

- on the normal screen
- on the alternate screen
- in a tmux pane mode such as copy mode

### 4.5 Geometry is implicit

The current payload does not carry the pane width/height used for the capture. That means the browser cannot tell whether it is rendering a capture that was produced under different dimensions than the current xterm instance.

### 4.6 The temporary blank-line trim is shell-specific

The current web experiment trims trailing blank lines before writing the snapshot. That helps a prompt-shaped shell snapshot, but it is structurally wrong for a TUI where blank rows are part of the current screen layout.

## 5. Verified tmux Capabilities We Are Not Using Yet

The local tmux docs confirm that tmux already exposes several pieces of metadata that matter for richer bootstrap:

- `capture-pane -a` uses the alternate screen
- `capture-pane -M` uses the pane-mode screen
- `capture-pane -N` preserves trailing spaces
- `capture-pane -J` preserves trailing spaces and joins wrapped lines
- format variables exist for:
  - `alternate_on`
  - `cursor_x`
  - `cursor_y`
  - `cursor_flag`
  - `cursor_shape`
  - `pane_width`
  - `pane_height`
  - `pane_in_mode`
  - `pane_mode`
  - `wrap_flag`

The current code does not fetch any of that metadata. It only captures flattened text.

## 6. Requirements For A Richer Bootstrap Contract

- Bootstrap must remain safe and replay-free.
- The contract must distinguish "current visible screen" from "optional history excerpt."
- Cursor-accurate restore should be possible for shell and TUI sessions.
- Pane geometry must be explicit.
- Screen mode must be explicit enough to distinguish normal screen from alternate screen and pane-mode captures.
- Degraded bootstrap must be explicit, not accidental.
- The browser must be able to decide what to do when capture geometry and current viewer geometry differ.

## 7. Recommendation

Keep the existing `/terminal/state` route, but evolve it from a `snapshot.text` shape into a richer `bootstrap` union with explicit fidelity levels.

Recommended top-level response shape:

```json
{
  "session_id": "sess_01...",
  "state": "ready",
  "latest_byte_offset": 10702,
  "readiness": { "...": "..." },
  "bootstrap": { "...": "..." },
  "updated_at": "2026-04-13T20:11:00.000Z"
}
```

## 8. Proposed Bootstrap Union

### 8.1 `bootstrap.kind: "grid"` (recommended primary path)

Use when the service can produce a cursor-aware, geometry-aware visible-screen capture.

Illustrative shape:

```json
{
  "kind": "grid",
  "source": "tmux_capture",
  "capture_scope": "normal",
  "pane": {
    "cols": 120,
    "rows": 40
  },
  "cursor": {
    "row": 18,
    "col": 27,
    "visible": true,
    "shape": "block"
  },
  "screen": {
    "lines": [
      "... exactly one string per visible row ..."
    ],
    "trailing_spaces_preserved": true,
    "wrapped_rows": null
  },
  "history_excerpt": null
}
```

Field notes:

- `capture_scope`
  - `normal`
  - `alternate`
  - `pane_mode`
- `pane.cols` / `pane.rows`
  - must reflect the geometry used for the capture
- `cursor.row` / `cursor.col`
  - should be `0`-based to match xterm buffer coordinates and tmux cursor variables
- `screen.lines`
  - should represent the exact visible rows of the captured pane
  - should not be a joined history transcript
- `history_excerpt`
  - optional convenience data
  - must not be required for xterm hydration
  - should never be conflated with the visible-screen grid

### 8.2 `bootstrap.kind: "text"` (explicit degraded fallback)

Use when the service cannot yet provide full cursor/geometry fidelity but still has a safe textual snapshot.

Illustrative shape:

```json
{
  "kind": "text",
  "source": "tmux_history_capture",
  "pane": {
    "cols": 120,
    "rows": 40
  },
  "text": "adam@host ~ %",
  "degraded_reason": "cursor_unavailable"
}
```

This is effectively today's first-pass snapshot, but made explicit as degraded.

The key point is that the browser can treat this as:

- acceptable for shell-like restore
- not cursor-accurate
- not suitable as a faithful TUI restore contract

### 8.3 `bootstrap.kind: "unavailable"`

Use when the Bud is offline, capture fails, or the system intentionally declines to produce a bootstrap surface.

Illustrative shape:

```json
{
  "kind": "unavailable",
  "reason": "bud_offline"
}
```

This is better than pretending we have a reliable snapshot when we do not.

## 9. Browser Hydration Semantics

### 9.1 `grid`

The browser should:

1. reset xterm
2. render the exact visible rows
3. place the cursor at `cursor.row` / `cursor.col`
4. preserve blank rows
5. attach the live stream at `latest_byte_offset`

Important:

- do not trim trailing blank rows in `grid` mode
- do not treat `history_excerpt` as part of the xterm hydration payload

### 9.2 `text`

The browser may render this as a best-effort shell-oriented fallback, but it should treat the result as degraded fidelity.

If we keep the current blank-line trim experiment temporarily, it should be restricted to `kind: "text"` only, never to `kind: "grid"`.

### 9.3 `unavailable`

The browser should avoid inventing state. It can show the empty terminal plus reconnect/offline UI and continue to use the live stream once available.

## 10. Optional Browser Render Pathways

There are two viable browser implementation pathways for `grid`.

### Path A: Safe generated ANSI render program

The browser generates a tiny, controlled render script that only uses safe sequences we choose explicitly, for example:

- clear screen
- move cursor
- print line text
- restore final cursor position
- optionally control cursor visibility

Pros:

- stays on xterm's public write path
- keeps bootstrap replay-safe because the sequence set is controlled by us
- avoids depending on xterm internals

Cons:

- we must be careful to preserve row layout exactly
- styling support should remain out of scope in the first pass

### Path B: Direct xterm buffer hydration

The browser writes captured rows/cursor state directly into xterm internals.

Pros:

- potentially the highest fidelity
- avoids ANSI render-sequence generation

Cons:

- relies on xterm internals
- more brittle across xterm upgrades

Recommendation:

- prefer Path A first
- only consider Path B if public-API rendering proves insufficient

## 11. Optional Geometry-Mismatch Pathways

When the capture geometry and the current viewer geometry differ, the browser needs an explicit policy.

### Option 1: Hydrate immediately anyway

Pros:

- simplest
- fastest perceived reopen

Cons:

- row wrapping and cursor placement may still be wrong
- especially risky for `capture_scope: "alternate"` or `pane_mode`

### Option 2: Resize then refetch before hydration

Pros:

- best chance of cursor/layout accuracy
- strongest fit for TUIs

Cons:

- extra round trip
- shared tmux geometry may change for other viewers

### Option 3: Hydrate degraded and mark stale until post-resize refresh

Pros:

- preserves fast reopen
- makes degraded state explicit

Cons:

- more UI complexity

Recommendation:

- for `bootstrap.kind: "grid"` with `capture_scope: "alternate"` or `pane_mode`, prefer resize-then-refetch when geometry mismatch is material
- for `bootstrap.kind: "text"`, best-effort render is acceptable

## 12. Optional Capture-Source Pathways

### Path A: Extend the current tmux-backed bootstrap route (recommended)

Keep `/terminal/state`, but change the capture source from "history-flavored joined text" to "visible-screen grid plus metadata."

That likely means:

- stop using joined history text as the primary bootstrap payload
- fetch pane metadata (`cursor_x`, `cursor_y`, `pane_width`, `pane_height`, `alternate_on`, `pane_in_mode`, `pane_mode`, `cursor_flag`, `cursor_shape`)
- capture the correct screen surface:
  - normal screen
  - alternate screen when `alternate_on = 1`
  - pane mode when `pane_in_mode > 0`

This is the best balance of simplicity and robustness.

### Path B: Keep text bootstrap but enrich it with cursor + geometry

This is smaller, but weaker.

It may be acceptable for shell prompts, but it does not solve the deeper problem that the current text payload is not an exact visible-screen grid.

### Path C: Introduce a dedicated daemon bootstrap message or render payload

This is the most invasive option.

It may become attractive later if we need richer style fidelity or stronger browser/daemon separation, but it is not necessary for the next step.

Recommendation:

- Path A is the right next implementation target

## 13. Current Implementation Unknowns

The richer contract direction is clear, but a few implementation questions are still open.

### 13.1 Exact tmux command shape for grid capture

We have verified that tmux exposes the right primitives, but we have not yet validated the exact command combination we want for:

- preserving trailing spaces
- avoiding wrapped-line flattening
- capturing alternate screen versus normal screen versus pane mode

### 13.2 Whether tmux row capture alone is enough for wrapped-row fidelity

The current use of `-J` is definitely wrong for exact screen reconstruction. What remains unknown is whether non-joined row capture plus pane dimensions is sufficient by itself, or whether we will need extra wrap metadata.

### 13.3 Browser cursor placement mechanism

We have not yet validated which browser-side hydration path is cleanest in xterm:

- safe generated ANSI render program
- direct internal buffer mutation

### 13.4 Multi-view geometry ownership

One thread can be opened in multiple browser pages. If a new page wants different terminal dimensions than the existing capture, we need an explicit policy for who "owns" remote pane geometry.

That is not new, but a richer bootstrap contract makes it more visible.

### 13.5 Whether history excerpt belongs in `/terminal/state`

It may be useful for shell context, but it must remain optional and clearly separate from the visible-screen bootstrap payload.

## 14. Decision Summary

We are already bootstrapping from tmux capture-pane. The issue is that the current bootstrap contract throws away the terminal state that matters for faithful reopen.

The next contract should:

- keep `/terminal/state`
- keep `latest_byte_offset`
- keep bootstrap separate from live stream replay
- replace the current implicit text snapshot with an explicit `bootstrap` union
- make `grid` the primary target
- keep `text` only as an explicit degraded fallback
- keep `unavailable` as an honest no-bootstrap case

Most important:

- bootstrap should become "current visible screen plus cursor and geometry"
- history should become optional sidecar context, not the thing we write into xterm

