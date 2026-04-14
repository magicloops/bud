# Phase 2: Keyboard, Paste, And Control Translation

**Parent Plan**: [implementation-spec.md](./implementation-spec.md)
**Status**: Draft

---

## Objective

Replace `xterm.onData` submission with explicit keyboard and paste intent translation while keeping the existing browser batching and fire-and-forget `/terminal/input` path.

By the end of this phase:

- the browser no longer submits outbound terminal input through `onData`
- supported keydown events translate into explicit terminal byte sequences
- paste text is handled explicitly
- raw `Ctrl+C` works
- leaked xterm-generated reply traffic no longer reaches tmux through this path

## Current Problem

The current route conflates:

- human keyboard input
- xterm-emitted terminal protocol traffic

Once we forward the `onData` string, the lower layers cannot recover that distinction.

## Scope

### In Scope

- `web/src/routes/$budId/$threadId.tsx`
- optional new helper under `web/src/lib/`
- explicit keydown and paste listeners
- raw control-byte and navigation-sequence translation
- continued use of the current `sendTerminalInput(...)` batching helper

### Out Of Scope

- service or Bud protocol redesign
- `terminal.send` integration
- IME/composition support
- Alt/Meta terminal forwarding

## Implementation Tasks

### Task 1: Remove outbound dependence on `term.onData(...)`

Stop using `term.onData(...)` as the source of browser submission.

The route may still use xterm for rendering, focus, selection, and DOM integration, but not as the authoritative source of outbound user bytes.

### Task 2: Add explicit keydown handling

Use xterm/browser keydown interception to translate supported user actions into explicit terminal input.

Recommended mechanism:

- `attachCustomKeyEventHandler(...)` for decision/control
- route supported terminal actions into the existing `sendTerminalInput(...)`
- let browser-native copy/paste handling continue where appropriate

### Task 3: Add explicit paste handling

Add an explicit paste handler on the terminal DOM integration point.

Requirements:

- read plain text from the clipboard event
- preserve multiline paste
- send the pasted text through the existing batching/send path
- do not rely on `Meta+V` / `Ctrl+V` as terminal key sequences

### Task 4: Translate supported actions to terminal bytes

Translate supported keys into the exact string we want to pass to `/terminal/input`.

Examples:

- printable text -> literal text
- `Enter` -> `\n`
- `Tab` -> `\t`
- `Backspace` -> `\x7f`
- `Escape` -> `\x1b`
- arrows / navigation -> VT escape sequences
- `Ctrl+A` through `Ctrl+Z` -> standard ASCII control bytes

### Task 5: Preserve browser copy behavior

Avoid regressing the currently working copy/paste behavior.

Expected phase-1 behavior:

- preserve copy behavior when the user is clearly copying selected text
- preserve browser-native paste behavior via the explicit paste handler
- do not claim `Alt` / `Meta` terminal support

### Task 6: Raw `Ctrl+C`

Implement `Ctrl+C` as raw terminal input bytes, not the dedicated interrupt endpoint.

This preserves expected shared-session semantics for:

- shell interrupts
- TUI interrupts
- REPL interrupts

### Task 7: Unsupported-combo logging

For development builds, log unsupported modifier combinations and named keys so we can discover whether phase-1 omissions matter in practice.

## Suggested Validation

- [ ] Focus/refocus no longer injects leaked control-sequence text.
- [ ] Printable typing still works at a shell prompt.
- [ ] `Enter`, `Tab`, and `Backspace` still work.
- [ ] Arrow-key shell editing still works.
- [ ] Raw `Ctrl+C` interrupts the foreground program.
- [ ] Multiline paste still works.
- [ ] Copy behavior remains intact in the known Chrome-on-macOS setup.
- [ ] Unsupported modifier combinations are visible in development logs rather than silently misbehaving.

## Exit Criteria

This phase is done when the browser terminal submits only explicit supported human-intent input and the known leaked-byte bug class is eliminated.
