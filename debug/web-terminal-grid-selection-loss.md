# Debug: web grid terminal — text selection collapses immediately

## Environment
- Web UI grid renderer (`thread-terminal-grid-pane.tsx`, default mode),
  any browser; reproduces idle AND while streaming.

## Repro Steps
1. Open a thread terminal (grid renderer).
2. Drag-select any terminal text and release the mouse.
3. Selection highlight disappears instantly; copying is impossible.
4. With a TUI streaming full frames, even a not-yet-released selection
   flickers away.

## Observed
- Highlight vanishes the moment the drag ends (no streaming needed).
- During streaming, any surviving selection dies on the next frame.

## Expected
- Native selection + copy (the grid renderer's design goal: "DOM rows with
  per-run spans give native selection/copy for free"), stable while new
  content streams.

## Root causes (two, code-confirmed; NOT the blinking cursor)
1. **Click-to-focus steals the selection**: the pane container has
   `onClick={focusIme}`. Completing a drag-selection fires a `click` on the
   container, and focusing the hidden IME `<textarea>` moves the document
   selection into the (empty) textarea — collapsing the highlight. This is
   the instant, streaming-independent loss. (The blinking cursor is a pure
   CSS animation on an absolutely positioned div — it never touches the
   row DOM or selection.)
2. **Full frames replace every row's DOM**: `applyGridFrame` builds a fresh
   `grid` array of fresh row arrays on every `full: true` frame, so every
   memoized `GridRow` re-renders and its text nodes are replaced — native
   selection anchored in them collapses. TUI streaming emits continuous
   fulls, so selections cannot survive streaming. Scrollback rows are also
   index-keyed (`sb-${index}`), so the 5000-row cap trim shifts every key
   and remounts all scrollback rows.

## Fix
1. Selection-aware focus: on click, if a non-collapsed selection is
   anchored inside the pane, focus the container (which never owns a text
   selection) instead of the IME textarea — the highlight survives, and
   both the copy shortcut and subsequent typed keys work from container
   focus (keydown translation lives on the container). Collapsed-selection
   clicks focus the IME as before (IME composition unchanged).
2. Row identity preservation in the reducer: a dirty row (including every
   row of a full frame) that is run-for-run equal to the current row keeps
   the previous array identity, so `GridRow` memo skips it and the DOM is
   untouched — full-frame streams only replace rows whose content actually
   changed, and selections anchored in stable rows survive.
3. Stable scrollback keys: state tracks `scrollbackStart` (absolute index
   of `scrollback[0]`, advanced by cap trims); rows key on the absolute
   index so trims/appends never remount surviving rows.

## Spec files affected
- `web/src/components/workbench/workbench.spec.md`
- `web/src/features/threads/threads.spec.md`
