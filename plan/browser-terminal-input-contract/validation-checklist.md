# Validation Checklist: Browser Terminal Input Contract

Manual validation completed on 2026-04-14. The browser terminal now works as expected for the current escape-hatch scope, and the leaked-character regression no longer reproduces.

## Leaked-Byte Regression

- [x] Reproduce the original focus/refocus case from [`reference/xterm-deepdive.md`](../../reference/xterm-deepdive.md) before the fix
- [x] Confirm refocus no longer injects leaked control-sequence text after the fix
- [x] Confirm repeated refocus does not inject DA/color/focus-report tail fragments

## Shell Basics

- [x] Type printable text at a shell prompt
- [x] Submit with `Enter`
- [x] Use `Backspace`
- [x] Use `Tab`
- [x] Use arrow-key shell editing
- [x] Use `Home` and `End` if supported by the foreground shell/editor state

## Control Keys

- [x] `Ctrl+C` interrupts a long-running shell command
- [x] `Ctrl+C` interrupts an active TUI/REPL flow where applicable
- [x] At least one additional raw `Ctrl+<letter>` mapping is spot-checked

## Paste / Copy

- [x] Single-line paste works
- [x] Multiline paste works
- [x] Copying selected terminal text still works in the known Chrome-on-macOS setup
- [x] Paste still works in the known Chrome-on-macOS setup

## Pager / Shared Session Flows

- [x] A basic pager flow works for the supported key set
- [x] Claude Code can be watched live from the browser terminal
- [x] Claude Code can be interrupted with `Ctrl+C`
- [x] A manual command can still be typed into the same shared tmux session after agent activity

## Terminal Lifecycle

- [x] Resize still works after window resize
- [x] Resize still works after thread-panel toggle
- [x] Reconnect/recovery still works after simulated disconnect
- [x] History backfill still renders on attach/recovery
- [x] Click-to-focus still works
- [x] Hidden/non-terminal view state does not accidentally submit input

## Explicit Limitations

- [ ] Unsupported `Alt` / `Meta` combos, if encountered, are recorded
- [x] IME/composition remains documented as unsupported/untested
- [x] No current workflow appears to need emulator-originated replies for the browser escape hatch
