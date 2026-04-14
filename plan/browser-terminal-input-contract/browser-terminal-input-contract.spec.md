# browser-terminal-input-contract

Implementation planning documents for hardening the browser terminal input contract so xterm.js no longer leaks emulator-generated protocol bytes into the shared tmux session.

## Purpose

This folder turns the review in [../../reference/xterm-deepdive.md](../../reference/xterm-deepdive.md) into an actionable phased implementation and validation plan.

The plan assumes:

- the browser terminal remains an escape hatch onto the same thread-scoped tmux session the agent uses
- the immediate fix should happen at the browser boundary, where user-intent provenance still exists
- phase 1 should keep the existing `/api/threads/:thread_id/terminal/input` and `terminal_input` path unless implementation proves otherwise
- phase 1 should support the common shell/pager/TUI rescue workflows rather than full terminal-emulator fidelity
- raw `Ctrl+C` should stay terminal-semantic input, not a separate interrupt-only browser affordance
- `Alt` / `Meta`, IME/composition, and emulator-originated replies remain out of scope for phase 1 unless validation reveals a blocking workflow
- a future PTY-backed browser attach path, if needed, should be a separate design/plan track rather than an extension of the phase-1 intent-only model

The plan folder's internal phases therefore subdivide only the original browser-boundary fix. They do **not** include the earlier conceptual second phase for a fully correct PTY-backed remote terminal.

## Files

### `implementation-spec.md`

Parent implementation spec for the browser-terminal input-contract work.

Documents:

- the current `onData`-based problem
- fixed scope and product decisions
- phase sequencing
- risks and definition of done

### `phase-1-browser-boundary-contract-and-input-catalog.md`

Contract-definition phase covering:

- supported key catalog
- shortcut precedence
- helper/module boundary
- development-only unsupported-event logging

### `phase-2-keyboard-paste-and-control-translation.md`

Behavior-cutover phase covering:

- removal of outbound `onData` dependence
- explicit keyboard translation
- explicit paste handling
- raw control-byte handling such as `Ctrl+C`

### `phase-3-thread-view-cutover-and-regression-hardening.md`

Integration-hardening phase covering:

- route lifecycle cleanup
- focus/view-mode behavior
- reconnect/history/resize regression checks
- keeping the thread route understandable

### `phase-4-validation-docs-and-follow-up-gate.md`

Finalization phase covering:

- manual validation
- spec/doc updates
- explicit limitation recording
- future PTY-backed attach follow-up gate

### `progress-checklist.md`

Running implementation checklist for the plan.

### `validation-checklist.md`

Manual verification checklist for the plan.

## Dependencies

- [../../reference/xterm-deepdive.md](../../reference/xterm-deepdive.md) - browser-boundary review and proposed architecture split
- [../../web/src/routes/$budId/$threadId.tsx](../../web/src/routes/$budId/$threadId.tsx) - current xterm/thread terminal route
- [../../service/src/routes/threads.ts](../../service/src/routes/threads.ts) - current browser terminal input endpoint
- [../../service/src/runtime/terminal-session-manager.ts](../../service/src/runtime/terminal-session-manager.ts) - current fire-and-forget terminal input forwarding
- [../../bud/src/main.rs](../../bud/src/main.rs) - current tmux injection path for `terminal_input`
- [../../bud.spec.md](../../bud.spec.md) - root architecture and documentation catalog

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- This folder intentionally stops short of a PTY-backed browser attach design. If validation reveals a real workflow that depends on emulator-originated replies or broader terminal fidelity, that follow-up should become a separate design and plan set.

---

*Referenced by: [../../bud.spec.md](../../bud.spec.md)*
