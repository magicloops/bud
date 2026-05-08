# terminal

Daemon-side tmux terminal runtime.

## Purpose

Owns thread terminal sessions on the Bud host. The module creates or reattaches tmux sessions, pipes output to the service, dispatches interactive input, captures screen/readiness state, reports pane cwd on request-response terminal results, and exposes narrow backend utilities needed by adjacent daemon adapters.

## Files

### `mod.rs`

Composition root for the terminal runtime.

- owns shared `TerminalState` with active handles and delivered-capture cache
- exposes `TerminalManager<TmuxBackend>::new(...)`
- stores the active outbound sender for terminal status/output frames
- clears active watchers on transport disconnect
- exposes `fresh_pane_cwd_for_session(session_id)` for file-serving path resolution without creating or mutating a terminal session

### `backend.rs`

Backend trait used by the terminal manager and tests.

- abstracts tmux session naming, creation, resizing, capture, input, pid/cwd lookup, and output watcher spawning

### `tmux.rs`

Tmux-backed implementation of `TerminalBackend`.

- maps service terminal session ids to bounded tmux session names
- creates detached sessions with configured shell/cwd/env/size
- configures `pipe-pane` output logging
- queries `#{pane_pid}` and `#{pane_current_path}`
- sends literal text and special keys
- captures panes for observe/readiness paths

### `registry.rs`

Terminal session lifecycle and ensure/close/resize helpers.

### `interaction.rs`

Terminal send/input handling, output waits, and request-response result construction. Successful `terminal_send_result` frames include optional `host_cwd` from `#{pane_current_path}` so the service can stamp later message metadata.

### `observe.rs`

Explicit observe request handling and screen/history capture. Successful `terminal_observe_result` frames include optional `host_cwd` from `#{pane_current_path}` so observe-only tool steps can also refresh service cwd context.

### `readiness.rs`

Prompt/readiness classification, quiescence waits, and settled/changed observe support.

### `delta.rs`

Screen delta helpers for concise terminal observations.

### `test_support.rs`

Fake backend and helpers for terminal unit tests.

## Dependencies

- [../app.rs](../app.rs) - dispatches terminal protocol frames and asks for fresh pane cwd before file opens with terminal context
- [../files/files.spec.md](../files/files.spec.md) - consumes fresh pane cwd metadata for cwd-first file resolution
- [../transport.rs](../transport.rs) - outbound terminal status/output frame delivery
- [../protocol.rs](../protocol.rs) - terminal frame definitions

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- The terminal runtime still has sparse folder-level unit coverage around tmux cwd reporting during foreground TUIs, pagers, nested shells, and REPLs; see the improve-file-cwd plan for the smoke matrix.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
