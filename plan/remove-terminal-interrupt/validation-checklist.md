# Remove `terminal.interrupt` Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md).

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` deferred or not applicable

## Phase 1: Send-Key Chords And Guidance

- [ ] `terminal.send.keys` accepts `C-c`
- [ ] `terminal.send.keys` accepts any additional shipped aliases intentionally
- [ ] Bud dispatches `C-c` through the general send-key path
- [ ] active prompt/tool guidance explicitly documents tmux notation
- [ ] active prompt/tool guidance uses `C-c` as the canonical `Ctrl+C` example

## Phase 2: Agent Removal And Browser Wrapper

- [ ] the agent tool surface exposes only `terminal.send` and `terminal.observe` for terminal interaction
- [ ] no model-facing tool parsing/execution branch for `terminal_interrupt` remains
- [ ] browser `POST /api/threads/:thread_id/terminal/interrupt` still returns success/failure correctly
- [ ] browser interrupt handling uses the shared send-key path
- [ ] no active renderer/spec still expects `terminal.interrupt` as a first-class agent tool

## Phase 3: Protocol / Dead-Code Cleanup

- [ ] dedicated service interrupt runtime helpers are removed if no active caller remains
- [ ] dedicated `terminal_interrupt` / `terminal_interrupt_result` wire handling is removed if no active caller remains
- [ ] dedicated Bud interrupt protocol handling is removed if no active caller remains
- [ ] active docs/specs no longer present `terminal.interrupt` as an agent tool
- [ ] browser-route docs still correctly document `/terminal/interrupt` as an escape hatch

## Real Flow Validation

### Agent

- [ ] agent can send `C-c` via `terminal.send`
- [ ] agent can send repeated `C-c` presses when needed
- [ ] agent uses `terminal.observe` as the explicit follow-up when interrupt effect is ambiguous

### Browser

- [ ] browser interrupt button/menu still works in a long-running shell command
- [ ] browser interrupt button/menu still works in a TUI session where `C-c` is consumed or needs repetition
- [ ] browser interrupt failure behavior still reports offline/session-missing correctly

## Active Reference Sweep

- [ ] `rg -n "terminal\\.interrupt|terminal_interrupt"` across active code/spec/docs leaves only intentional matches
- [ ] remaining matches are limited to:
- [ ] browser `/terminal/interrupt` route/docs
- [ ] historical design/debug/review/plan material
- [ ] the new removal design/plan docs
