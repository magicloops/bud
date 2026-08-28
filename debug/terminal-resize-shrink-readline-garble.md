# Debug: garbled terminal rows after mobile/web width changes (bash)

## Environment
- Ubuntu box, bash 5.2.21, daemon ≥ v0.1.13, thread started on mobile
  (48 cols) and later viewed on desktop web (122 cols). Both viewers are
  first-class geometry owners. Same garbling on the grid and xterm renderers.
- On web at capture time: `TERM=xterm-256color`, `COLUMNS=122 LINES=61` ==
  `stty size`, `checkwinsize on` — bash tracked the current size correctly.

## Observed
Only long (multi-row) command lines garble: a duplicate copy of the
command, then output written over earlier rows without clearing —
`app.js OK` replaced exactly the first 9 chars of `adam@spark-1:…$ …`
(`adam@spar`), `PY` over `  n = len(colors)` — until the cursor caught up
with the real bottom. Not "squashed": overwritten at column 0.

## Root cause (reproduced, bash 5.2.21 and 5.3, real `terminal_send` path)
readline's SIGWINCH redisplay vs the emulator's reflow. When the PTY width
SHRINKS while a multi-row readline line is displayed, alacritty reflows
the line to more rows immediately, but readline redisplays it using its
pre-resize row count: the cursor lands rows too high, prompt+line are
redrawn there (the duplicate copy) and every following output row lands
too high (the overwrites). Growing with a line pending, rows-only changes
(keyboard show/hide), and steady state at either width are all clean.

Why it hit so often: `terminal_send` submit = bracketed paste, a 75 ms
beat, then Enter, all under the per-session lock. A resize arriving in that
window queues behind the lock and lands right after the Enter byte —
before bash has consumed it — so every agent command had a ~75 ms window
in which any width shrink (mobile taking geometry from web) garbled it.
Reproduced: shrink at +10/+40 ms into the send → triple command copies and
`done-markersta / rt`.

## Fix (daemon)
`SessionFacts.input_pending_at_prompt`: set when text/paste/raw input lands
on an idle shell prompt (mode shell, no open command); cleared by
`command_started`, `prompt_ready`, close, or a mode change. `handle_resize`
DEFERS width shrinks while it is set (grows/rows-only apply at once; TUIs
and REPLs are never deferred), applying the newest deferred geometry on the
next `command_started`/`prompt_ready` or after `RESIZE_DEFER_CAP` (3 s),
then announcing `ready` as usual. Covers the paste→Enter gap, the
post-Enter race, and a human composing a long line while another device
shrinks.

Regressions (`bud/tests/terminal_stem.rs`, bash 5.x via
`/opt/homebrew/bin/bash` or `BUD_REGRESSION_BASH`, skipped when absent):
`resize_shrink_defers_behind_pasted_submit`,
`resize_shrink_defers_while_line_pending_at_prompt`.

## Known limitation (separate readline artifact)
A PROMPT longer than the narrow viewer's width wraps to multiple rows; a
later width change makes readline redisplay the prompt with its old row
count, eating the previous output row (grow) or duplicating (shrink).
Nothing is pending, so deferral cannot help; keep `\w`-style prompts under
~40 chars on phone-width sessions, or avoid width flips at idle prompts.
