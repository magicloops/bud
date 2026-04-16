# Debug: terminal.send settled-by-default refactor

## Environment

- OS / arch / versions: local development workspace on macOS, Bud daemon in Rust, service in Node.js/TypeScript
- DB connection style: PostgreSQL via Drizzle ORM
- LLM mode: real provider contract, local code-path inspection only for this note

## Repro Steps

1. Start a thread with an active tmux-backed terminal session.
2. Let the agent call `terminal.send` for a normal shell command or interactive TUI action.
3. Observe that `terminal.send` often returns quickly with a fast post-send capture.
4. Observe that the model then issues one or more `terminal.observe` calls to wait for the actual settled state.

## Observed

- Bud already has an existing `pipe-pane` output watcher that polls the terminal log every `50ms` and streams `terminal_output`.
- Bud still drives agent-facing `settled` waiting from repeated `capture-pane` polling in `wait_for_screen_state(...)`.
- `terminal.send` still defaults to `wait_for: "none"`, `observe_after_ms: 1000`, and a `5000ms` timeout in the service/runtime path.
- The service prompt still teaches the model around the fast-observe contract rather than a settled-by-default send contract.

## Expected

- `terminal.send` should normally return once output has gone quiet or a larger timeout is reached.
- Bud should use the existing `pipe-pane` watcher state as the primary settle detector.
- `capture-pane` should remain for baseline/final rendered state, not the hot waiting loop.
- `terminal.observe(wait_for:"settled")` should remain available for explicit longer waits after timeout or ambiguity.

## Hypotheses

- The main waste comes from the current split between:
  - cheap output activity detection already present in the watcher
  - more expensive rendered-state polling still used for send/observe settled waits
- Reusing watcher-maintained output activity in memory should let Bud decide "visually quiet" without repeated `capture-pane` calls.
- Once Bud returns settled-or-timeout results by default, the service prompt and runtime defaults can become simpler and should stop encouraging immediate observe follow-ups.

## Proposed Fix

- Add shared output-activity fields to the Bud terminal-session handle and update them inside the existing output watcher.
- Implement a quiescence wait helper in Bud that polls that shared in-memory activity state on a short interval and returns `settled` or `timeout`.
- Change `terminal.send` to default to settled waiting with a larger timeout, using:
  - baseline capture
  - dispatch
  - output-quiescence wait
  - final capture
- Change `terminal.observe(wait_for:"settled")` to use the same output-quiescence wait before final capture.
- Update the service runtime defaults, agent prompt/tool guidance, protocol docs, and related specs to match the new behavior.

## Spec Files Affected

- `bud/src/src.spec.md`
- `bud/bud.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/ws/ws.spec.md`
- `web/src/components/message-renderers/tools/tools.spec.md`
- `bud.spec.md`
