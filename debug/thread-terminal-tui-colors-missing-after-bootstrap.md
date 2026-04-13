# Debug: TUI Colors Missing After Bootstrap

## Environment
- Web thread view using the richer `/terminal/state` bootstrap contract (`grid` / `text` / `unavailable`).
- Existing tmux-backed terminal session already running a styled TUI.
- Symptom appears on page refresh or when opening the same thread in a separate page.
- Live streaming on an already-open page still shows colors correctly.

## Repro Steps
1. Open a thread terminal and launch a colored TUI.
2. Observe that the TUI renders with colors while live terminal output is streaming.
3. Refresh the page or open the same thread in a new page.
4. Observe the bootstrapped terminal state before any new live output arrives.

## Observed
- Screen text, blank rows, and cursor placement mostly restore on refresh/new page.
- TUI colors/styles do not restore through bootstrap.
- Once new live terminal output arrives, colors/styles appear again.

## Expected
- Refresh/new-page bootstrap should preserve the currently visible TUI styling as faithfully as the live streaming path, or degrade in an explicit and documented way.

## Current Bootstrap Review
- `GET /api/threads/:thread_id/terminal/state` in `service/src/routes/threads.ts` returns `latest_byte_offset` plus a browser-facing `bootstrap` payload. It does not replay raw terminal bytes.
- `captureBootstrap(...)` in `service/src/runtime/terminal-session-manager.ts` gets that payload by issuing `terminal_observe(view: "screen")` to the Bud daemon.
- Bud `capture_visible_screen_state(...)` in `bud/src/main.rs` fetches tmux pane metadata, then captures the visible screen with `tmux capture-pane -p -N` plus `-a` for alternate-screen captures or `-M` for pane-mode captures.
- The daemon currently returns a `screen_state` with:
  - pane size
  - cursor row/col/shape/visibility
  - capture scope / pane mode
  - `screen.lines: string[]`
- The current `TerminalScreenStateMessage` and `BrowserTerminalBootstrap` contracts in `service/src/terminal/types.ts` are text-grid based. They do not carry per-cell style attributes, SGR state, or a style-preserving ANSI bootstrap payload.
- Browser grid bootstrap in `web/src/lib/thread-terminal-controller.ts` rebuilds the screen with `buildGridBootstrapRenderSequence(...)` by:
  - clearing the screen
  - positioning the cursor per row
  - writing each row as plain text
  - restoring final cursor position, shape, and visibility
- Browser live output in that same controller goes through `writeOutput(...)`, which decodes streamed terminal bytes and passes the resulting text directly into `terminal.write(...)`.

## Findings
- The current rich bootstrap contract is cursor-aware and geometry-aware, but style-blind.
- Live TUI colors work because SSE `terminal.output` preserves the terminal's original ANSI/SGR byte stream.
- Refresh/new-page bootstrap loses colors because the bootstrap payload only contains plain text rows, and the browser renderer only reconstructs plain text plus cursor-control sequences.
- This is structural, not intermittent:
  - style is not represented in `screen_state.screen.lines`
  - the browser grid renderer has no style data to reapply
- The current bootstrap design is good enough for shell text and cursor fidelity, but not sufficient for full-screen TUIs that depend on color/styling for meaning.

## Unknowns
- Whether tmux can provide a safe style-preserving visible-screen capture for normal, alternate, and pane-mode screens that is robust enough for bootstrap.
- Whether the better long-term bootstrap shape is:
  - styled cells / attributes
  - a controlled ANSI render payload
  - both, with an explicit fallback ladder
- How style-aware bootstrap should behave when local xterm geometry does not match the captured pane geometry.
- Whether bootstrap fidelity also needs to preserve terminal palette/state beyond text styling, or whether default xterm theme mapping is sufficient.

## Hypotheses
- Primary: styles are dropped at the contract boundary because `screen_state` only carries text rows plus cursor/geometry metadata.
- Secondary: the daemon's visible-screen capture path currently requests `capture-pane -p -N`, so it may be omitting style-preserving output before the service/browser ever see the screen.
- Secondary: even if tmux can provide styled capture data, the current browser `buildGridBootstrapRenderSequence(...)` path would still discard it because it writes plain row strings.

## Optional Pathways
- Path A: extend bootstrap to a styled cell grid.
  - Most explicit and safest for xterm hydration, but a larger contract change.
- Path B: extend bootstrap to carry a controlled ANSI render payload for the visible screen.
  - Closer to tmux/xterm behavior, but requires careful replay and safety rules.
- Path C: keep plain bootstrap and rely on later live redraw bytes.
  - Lowest effort, but not sufficient for refresh/new-page TUI fidelity.

## Proposed Fix
- No code change in this note.
- The next design step should focus on a style-aware bootstrap contract rather than more replay changes.
- Likely affected docs/contracts if we pursue this:
  - `bud/src/main.rs`
  - `service/src/terminal/types.ts`
  - `service/src/routes/threads.ts`
  - `web/src/lib/thread-terminal-controller.ts`
  - `docs/proto.md`
