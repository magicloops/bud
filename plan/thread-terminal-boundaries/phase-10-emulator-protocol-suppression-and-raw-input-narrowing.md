# Phase 10: Emulator Protocol Suppression And Raw Input Narrowing

Companion phase for [implementation-spec.md](./implementation-spec.md).

## Goal

Eliminate the remaining live browser-terminal leak class where xterm-generated terminal replies are forwarded upstream as raw pane input.

This phase revisits one deliberate Phase 9 decision. We kept `/terminal/input` as a narrow fallback for both:

- `emulator_protocol` from xterm
- unsupported human key sequences

New Codex TUI validation shows those are not equally valid uses of the raw path.

## Context

Post-cleanup validation found a new symptom while running the Codex TUI in the thread terminal:

- startup can print payloads like `10;rgb:d1d1/ffff/e1e111;rgb:0000/0000/0000`
- refocusing the live xterm view, without page switch or refresh, can print payloads like `11;rgb:0000/0000/0000`

The corresponding debug note is [../../debug/thread-terminal-codex-tui-osc-color-reply-leak.md](../../debug/thread-terminal-codex-tui-osc-color-reply-leak.md).

The strongest reading is:

- Codex TUI issues OSC `10` / `11` terminal color queries
- xterm generates a real terminal-emulator reply
- the browser classifies that output as `emulator_protocol`
- the reference web client forwards it upstream through `/terminal/input`
- the Bud/tmux path does not behave like a faithful terminal-reply channel
- the foreground program ends up seeing printable payload fragments instead of a parseable terminal response

This matters because the symptom reproduces on simple xterm refocus. That rules out bootstrap, reconnect replay, and page lifecycle as the primary trigger. The remaining bug is in the live emulator-protocol path.

## Preconditions

Before this phase is considered complete:

- structured browser typing on `terminal_send` remains fast and stable
- shell reopen and TUI reopen behavior remain stable under the richer bootstrap contract
- the remaining human raw-fallback cases are clearly understood as parser/key-coverage gaps rather than general typing needs

## Scope

### 1. Browser Emulator-Protocol Policy

Change the browser boundary so `emulator_protocol` is no longer forwarded upstream by default.

Expected policy:

- browser-generated terminal replies are suppressed locally unless explicitly allowlisted
- the default assumption is that xterm-generated protocol is not equivalent to pane stdin
- any retained forwarding must be justified sequence-by-sequence, not by broad source class

Expected outcome:

- Codex TUI focus/startup no longer leaks OSC color-reply payload into the app
- the browser stops treating xterm protocol output as a normal upstream transport

### 2. Raw Input Contract Narrowing

Re-scope `/terminal/input` around unsupported human input only.

Target direction:

- the reference web client should no longer use `/terminal/input` for `emulator_protocol`
- if `/terminal/input` remains, it should exist only as a temporary escape hatch for human key sequences the browser cannot yet express via structured `terminal_send`
- once human key coverage is sufficient, the route can be reconsidered again for full removal

Expected outcome:

- `/terminal/input` is no longer justified by emulator-reply forwarding
- the route becomes obviously temporary and narrow instead of conceptually overloaded

### 3. Structured Human Key Coverage Expansion

Reduce the remaining need for raw human fallback by expanding browser-side structured key handling.

Priority input classes:

- additional `Ctrl+<key>` chords such as `Ctrl+A`, `Ctrl+D`, `Ctrl+L`, `Ctrl+U`, `Ctrl+W`, `Ctrl+Z`
- `Alt` / `Meta` chords used by shells and TUIs
- `Shift+Tab`
- function keys
- modified navigation keys such as `Ctrl+Left`, `Alt+Right`, `Shift+Up`

Expected outcome:

- normal shell and common TUI interaction no longer depend on byte-exact raw fallback
- the remaining raw surface is small enough to reason about explicitly

### 4. Contract And Docs Alignment

Update docs/specs so the intended contract is explicit:

- browser human typing uses structured `terminal_send`
- xterm-generated `emulator_protocol` is not a valid generic upstream lane
- `/terminal/input` is a temporary unsupported-human fallback, not a terminal-reply channel

Expected outcome:

- future work does not accidentally re-expand the raw path
- browser/service/daemon docs all describe the same boundary

## Deliverables

- browser controller no longer forwards `emulator_protocol` upstream by default
- no emulator-protocol forwarding remains in the reference web client; future forwarding would require an explicit allowlist
- `/terminal/input` no longer serves as the generic sink for xterm-generated terminal replies
- structured browser key coverage expands for the highest-value TUI/shell shortcuts, including previously raw human control/escape sequences via literal `terminal_send.text`
- updated docs/specs/plan notes that describe `/terminal/input` as human-fallback-only if it remains

## Success Criteria

- [ ] Codex TUI startup no longer prints OSC color-reply payload into the input area.
- [ ] Refocusing the live xterm view no longer injects OSC color-reply payload into the foreground program.
- [ ] The reference web client does not forward `emulator_protocol` through `/terminal/input` by default.
- [ ] `/terminal/input` is retained only for unsupported human sequences, or removed entirely if no longer needed.
- [ ] Structured browser key handling covers the validated high-value shell/TUI shortcuts that previously required raw fallback.
- [ ] Docs/specs clearly state that emulator replies are not equivalent to pane stdin.

## Expected Files

- `web/src/lib/terminal-xterm-input.ts`
- `web/src/lib/thread-terminal-controller.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/lib/api.ts`
- `service/src/routes/threads.ts`
- `service/src/routes/routes.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `web/src/lib/lib.spec.md`
- `web/src/routes/$budId/budId.spec.md`
- `docs/proto.md`
- `plan/thread-terminal-boundaries/implementation-spec.md`
- `plan/thread-terminal-boundaries/progress-checklist.md`
- `plan/thread-terminal-boundaries/validation-checklist.md`
- `plan/thread-terminal-boundaries/thread-terminal-boundaries.spec.md`
- `bud.spec.md`

## Non-Goals

- implementing a full terminal-emulator reply channel through tmux in this phase
- making bootstrap style-faithful for TUI colors
- claiming complete keyboard coverage across every browser and OS combination
- removing `/terminal/input` before validated human fallback coverage exists

## Risks And Notes

- Some TUIs may actually rely on terminal query replies that our browser/tmux stack cannot currently support faithfully. In those cases, suppressing the reply may be safer than forwarding corrupted data, but it can still reduce capability.
- Browser key coverage work should be driven by validated human use cases, not by trying to mirror every possible escape sequence up front.
- If an allowlist is introduced for emulator replies, it should remain extremely small and justified by end-to-end validation, not convenience.
